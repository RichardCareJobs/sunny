"""Steps 2–5 — match venues to OSM, resolve heights, place seating points and
compute 72-direction horizon profiles.

  python tools/sun/build_profiles.py --city dublin

Inputs (tools/sun/data/<city>/):
  venues.json            place_id, name, enrichment signals (export_venues.sql)
  osm/osm_extract.json   from extract_osm.py
  existing_seating.json  optional: current venue_seating rows; manual/venue rows
                         are never overwritten and are used as-is for horizons
Optional (tools/sun/):
  derived/<lidar heights csv>   from lidar_heights.py
  overrides/<city>_seating.csv  manual seating points (place_id,lat,lng,type,height_m)

Outputs (tools/sun/data/<city>/out/):
  seating.json, profiles.json, manual_fix_list.csv, lidar_disagreements.csv,
  run_summary.json

Licence: venue names (Google) are used only to find the matching OSM feature.
Every coordinate and height written out is derived from OSM / LiDAR / Sunny.
"""
import argparse
import csv
import difflib
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon

from common import ALGORITHM_VERSION, LocalProjection, city_data_dir, load_city, HERE

PROTECTED_SOURCES = {"manual", "venue"}
MATCH_ACCEPT = 0.88
AMBIGUOUS_GAP = 0.02
AMBIGUOUS_DIST_M = 80
REAR_TAGS = {"beer garden", "back garden", "courtyard", "garden"}
ROOF_TAGS = {"roof terrace", "rooftop", "rooftop bar", "roof garden"}


def log(*a):
    print("[profiles]", *a, file=sys.stderr, flush=True)


# ── Name matching ────────────────────────────────────────────────────────────
STOP_TOKENS = {"the", "and", "co", "ltd", "dublin"}
WEAK_TOKENS = {"pub", "bar", "bars", "lounge", "kitchen", "restaurant", "inn", "tavern", "cafe", "bistro",
               "gastro", "gastropub", "grill", "house", "hotel", "brasserie", "public", "irish", "traditional",
               "venue", "and", "apartments", "lodgings", "studio", "eatery", "diner"}
SAME_VENUE_M = 150     # same-name OSM features this close are one venue mapped twice
PLACE_HINT_M = 1500


def tokens(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("'", "").replace("`", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return [t for t in s.split() if t not in STOP_TOKENS]


def split_venue_name(name, place_names):
    """-> (main name, place hint or None). Drops '- descriptor' tails, and
    'X of <place>' / 'X <place>' suffixes when <place> is an OSM place name."""
    main = re.split(r"\s+[-|@–]\s+|\s*\(|\s*\|", name or "")[0]
    hint = None
    m = re.match(r"^(.*\S)\s+of\s+(.+)$", main, re.I)
    if m and tokens(m.group(1)):
        main, hint = m.group(1), " ".join(tokens(m.group(2)))
    else:
        toks = tokens(main)
        for k in (3, 2, 1):
            if len(toks) > k and " ".join(toks[-k:]) in place_names:
                hint = " ".join(toks[-k:])
                main = " ".join(toks[:-k])
                break
    return main, hint


def name_score(vt, pt):
    """Score two token lists (stop words removed)."""
    if not vt or not pt:
        return 0.0
    if vt == pt:
        return 1.0
    vc = [t for t in vt if t not in WEAK_TOKENS] or vt
    pc = [t for t in pt if t not in WEAK_TOKENS] or pt
    if vc == pc:
        return 0.96
    a, b = set(vc), set(pc)
    small, big = (a, b) if len(a) <= len(b) else (b, a)
    if small <= big and max(len(t) for t in small) >= 4:
        if len(small) >= 2:
            return 0.92
        # one distinctive word: only if everything else is generic
        # ("Fidelity" ~ "Fidelity Bar & Studio", not "Canal Boat" ~ "Canal Bar")
        if len(next(iter(small))) >= 5 and not ((set(vt) | set(pt)) - small - WEAK_TOKENS):
            return 0.89
    return difflib.SequenceMatcher(None, " ".join(sorted(a)), " ".join(sorted(b))).ratio() * 0.95


def district_key(city_label):
    """'Dublin 4' -> 'D04', 'Dublin 6W' -> 'D6W'; None otherwise."""
    m = re.match(r"^dublin\s*0?(\d{1,2})(w?)$", (city_label or "").strip().lower())
    if not m:
        return None
    return "D6W" if m.group(2) else f"D{int(m.group(1)):02d}"


def match_venues(venues, ext, proj, use_district_hint=False):
    pois = ext["pois"]
    places = {}
    for pl in ext.get("places", []):
        places.setdefault(" ".join(tokens(pl["name"])), proj.fwd(pl["lon"], pl["lat"]))
    pc_pts = np.array([proj.fwd(lon, lat) for lon, lat, _ in ext.get("postcodes", [])]) if ext.get("postcodes") else None
    pc_keys = [k for _, _, k in ext.get("postcodes", [])]
    pc_tree = shapely.STRtree(shapely.points(pc_pts)) if pc_pts is not None else None

    def poi_district(p, x, y):
        own = (p.get("addr") or {}).get("postcode")
        if own:
            return own.strip().upper()[:3]
        if pc_tree is None:
            return None
        idx = pc_tree.query(Point(x, y).buffer(300))
        votes = Counter(pc_keys[i] for i in idx)
        return votes.most_common(1)[0][0] if votes else None

    index = defaultdict(set)
    prepared = []
    for p in pois:
        names = []
        for n in p["names"].values():
            t = tokens(n)
            if t and t not in names:
                names.append(t)
        x, y = proj.fwd(p["lon"], p["lat"])
        prepared.append((p, names, x, y))
        for t in names:
            for tok in t:
                index[tok].add(len(prepared) - 1)

    results = {}
    for v in venues:
        main, hint = split_venue_name(v["name"], places)
        variants = [tokens(main)]
        full = tokens(v["name"])
        if full != variants[0]:
            variants.append(full)
        cand_idx = set()
        for vt in variants:
            for tok in vt:
                if tok not in WEAK_TOKENS:
                    cand_idx |= index.get(tok, set())
        scored = []
        for i in cand_idx:
            p, names, x, y = prepared[i]
            sc = max(name_score(vt, n) for vt in variants for n in names)
            if p["amenity"] in ("pub", "bar", "biergarten", "nightclub"):
                sc += 0.005
            scored.append((min(sc, 1.0), i))
        scored.sort(reverse=True)
        if not scored or scored[0][0] < MATCH_ACCEPT:
            results[v["place_id"]] = {"status": "unmatched",
                                      "candidates": [prepared[i][0]["names"].get("name") for _, i in scored[:3]]}
            continue
        top = scored[0][0]
        tied = [i for sc, i in scored if sc >= top - AMBIGUOUS_GAP]
        # collapse duplicates of the same venue (point + outline, etc.)
        groups = []
        for i in tied:
            for g in groups:
                if math.hypot(prepared[i][2] - prepared[g[0]][2], prepared[i][3] - prepared[g[0]][3]) <= SAME_VENUE_M:
                    g.append(i); break
            else:
                groups.append([i])
        method = "name_exact" if top >= 0.96 else "name_fuzzy"
        if len(groups) > 1 and hint and hint in places:
            hx, hy = places[hint]
            dist = sorted((math.hypot(prepared[g[0]][2] - hx, prepared[g[0]][3] - hy), k) for k, g in enumerate(groups))
            if dist[0][0] <= PLACE_HINT_M and (len(dist) == 1 or dist[1][0] > 1.5 * dist[0][0]):
                groups = [groups[dist[0][1]]]
                method += "+place"
        if len(groups) > 1 and use_district_hint:
            dk = district_key(v.get("city"))
            if dk:
                hits = [g for g in groups if poi_district(prepared[g[0]][0], prepared[g[0]][2], prepared[g[0]][3]) == dk]
                if len(hits) == 1:
                    groups = hits
                    method += "+district"
        if len(groups) > 1:
            results[v["place_id"]] = {"status": "ambiguous",
                                      "candidates": [f'{prepared[g[0]][0]["names"].get("name")} ({prepared[g[0]][0]["id"]})'
                                                     for g in groups[:4]]}
            continue
        # prefer the outline (way/relation) over a point when both exist
        g = sorted(groups[0], key=lambda i: (prepared[i][0]["id"].startswith("node"), -scored[[j for _, j in scored].index(i)][0]))
        p = prepared[g[0]][0]
        results[v["place_id"]] = {"status": "matched", "poi": p, "score": round(top, 3), "method": method}
    # One OSM feature claimed by several venues: fine when both are strong
    # (Google often lists a pub and its restaurant separately); otherwise keep
    # the best and queue the rest.
    by_poi = defaultdict(list)
    for pid, r in results.items():
        if r["status"] == "matched":
            by_poi[r["poi"]["id"]].append((r["score"], pid))
    for poi_id, claims in by_poi.items():
        if len(claims) > 1:
            claims.sort(reverse=True)
            for sc, pid in claims[1:]:
                if sc < 0.96:
                    results[pid] = {"status": "poi_conflict", "candidates": [poi_id]}
    return results


# ── Heights ──────────────────────────────────────────────────────────────────
def load_lidar(city):
    path = os.path.join(HERE, "derived", city["lidar"]["heights_csv"])
    out = {}
    if not os.path.exists(path):
        log(f"no LiDAR heights at {path}; using OSM/default only")
        return out
    with open(path) as f:
        rows = [r for r in f if not r.startswith("#")]
    for r in csv.DictReader(rows):
        out[r["osm_id"]] = float(r["lidar_height_m"])
    log(f"{len(out)} LiDAR building heights loaded")
    return out


def resolve_height(b, lidar, hcfg):
    """Returns (height_m, rule, osm_estimate_or_None)."""
    osm = None
    if b.get("height"):
        osm, osm_rule = b["height"], "osm_height"
    elif b.get("levels"):
        osm = (b["levels"] * hcfg["storey_m"] + hcfg.get("levels_base_m", 0)
               + (b.get("roof_levels") or 0) * hcfg["roof_storey_m"])
        osm_rule = "levels"
    base_id = b["id"].split("#")[0]
    if base_id in lidar and not b.get("part"):
        lh = lidar[base_id]
        # The LiDAR is from March 2015. An explicit OSM height well above it
        # usually means the building was built or extended since; trust OSM.
        if b.get("height") and b["height"] - lh > max(hcfg["lidar_disagree_abs_m"], hcfg["lidar_disagree_rel"] * lh):
            return b["height"], "osm_height", osm
        return lh, "lidar", osm
    if osm is not None and osm > 0:
        return osm, osm_rule, osm
    return hcfg["default_m"], "default", None


# ── Geometry helpers ─────────────────────────────────────────────────────────
def unit(vx, vy):
    n = math.hypot(vx, vy)
    return (vx / n, vy / n) if n else (0.0, 0.0)


def edges_of(poly):
    c = list(poly.exterior.coords)
    return [(c[i], c[i + 1]) for i in range(len(c) - 1)]


def outward_point(poly, a, b, foot, dist):
    ex, ey = unit(b[0] - a[0], b[1] - a[1])
    nx, ny = ey, -ex
    test = Point(foot[0] + nx * 0.2, foot[1] + ny * 0.2)
    if poly.contains(test):
        nx, ny = -nx, -ny
    return (foot[0] + nx * dist, foot[1] + ny * dist)


def foot_on_edge(a, b, p, margin=1.0):
    ex, ey = b[0] - a[0], b[1] - a[1]
    L = math.hypot(ex, ey)
    t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (L * L)
    lo, hi = min(margin / L, 0.5), max(1 - margin / L, 0.5)
    t = min(max(t, lo), hi)
    return (a[0] + ex * t, a[1] + ey * t)


class World:
    def __init__(self, buildings, streets, heights):
        self.b = buildings          # list of dicts with poly (local m)
        self.h = heights            # list of (height, rule, osm)
        self.polys = [x["poly"] for x in buildings]
        self.tree = shapely.STRtree(self.polys)
        self.main_idx = [i for i, x in enumerate(buildings) if not x["part"]]
        self.streets = streets
        self.stree = shapely.STRtree([s["line"] for s in streets]) if streets else None
        # flat segment arrays for ray casting
        A, B, owner = [], [], []
        for i, p in enumerate(self.polys):
            for ring in [p.exterior, *p.interiors]:
                c = np.asarray(ring.coords)
                A.append(c[:-1]); B.append(c[1:]); owner.append(np.full(len(c) - 1, i))
        self.A = np.concatenate(A); self.B = np.concatenate(B); self.owner = np.concatenate(owner)
        mid = (self.A + self.B) / 2
        self.seg_tree = shapely.STRtree(shapely.points(mid))
        self.H = np.array([h[0] for h in heights])

    def inside_any(self, pt, exclude=None):
        P = Point(pt)
        for j in self.tree.query(P, predicate="intersects"):
            if j != exclude and not self.b[j]["part"]:
                return True
        return False

    def building_for(self, poi_id, x, y):
        P = Point(x, y)
        same = [i for i in self.tree.query(P.buffer(200)) if self.b[i]["id"].split("#")[0] == poi_id]
        if same:
            return same[0], "poi_is_building"
        hits = [i for i in self.tree.query(P, predicate="intersects") if not self.b[i]["part"]]
        if hits:
            return min(hits, key=lambda i: self.polys[i].area), "poi_inside"
        near = [i for i in self.tree.query(P.buffer(20)) if not self.b[i]["part"]]
        if near:
            return min(near, key=lambda i: self.polys[i].distance(P)), "poi_near"
        return None, "no_building"

    def nearest_street(self, poly):
        if self.stree is None:
            return None
        cand = self.stree.query(poly.buffer(80))
        if len(cand) == 0:
            return None
        named = [i for i in cand if self.streets[i]["name"]]
        pool = named or list(cand)
        return min(pool, key=lambda i: self.streets[i]["line"].distance(poly))

    def place_seating(self, bi, poi_xy, mode, offset):
        poly = self.polys[bi]
        si = self.nearest_street(poly)
        street = self.streets[si]["line"] if si is not None else None
        cands = []
        for a, b in edges_of(poly):
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 2:
                continue
            foot = foot_on_edge(a, b, poi_xy)
            seat = outward_point(poly, a, b, foot, offset)
            if self.inside_any(seat):
                continue  # party wall to a neighbour
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            d = street.distance(Point(mid)) if street is not None else 0.0
            cands.append((d, seat))
        if not cands:
            return None, "no_open_edge"
        cands.sort(key=lambda c: c[0])
        if mode == "rear":
            far = cands[-1]
            if far[0] - cands[0][0] >= 5:
                return far[1], "rear_edge"
            return cands[0][1], "rear_fallback_front"
        return cands[0][1], "front_edge" if street is not None else "edge_no_street"

    def horizon(self, x, y, eye_z, R, exclude_building=None):
        idx = self.seg_tree.query(Point(x, y).buffer(R + 60))
        if exclude_building is not None:
            idx = idx[self.owner[idx] != exclude_building]
        A = self.A[idx]; B = self.B[idx]; own = self.owner[idx]; h = self.H[own]
        az = np.radians(np.arange(72) * 5.0)
        dx, dy = np.sin(az)[:, None], np.cos(az)[:, None]   # x east, y north
        ex, ey = (B[:, 0] - A[:, 0])[None, :], (B[:, 1] - A[:, 1])[None, :]
        wx, wy = (A[:, 0] - x)[None, :], (A[:, 1] - y)[None, :]
        den = dx * ey - dy * ex
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (wx * ey - wy * ex) / den
            u = (wx * dy - wy * dx) / den
        ok = (np.abs(den) > 1e-9) & (t > 0.3) & (t <= R) & (u >= 0) & (u <= 1)
        ang = np.where(ok, np.degrees(np.arctan2(h[None, :] - eye_z, np.where(ok, t, 1.0))), -90.0)
        best = ang.max(axis=1)
        horizon = np.maximum(best, 0.0)
        hit_buildings = set(np.unique(own[ok.any(axis=0)]).tolist())
        return horizon, hit_buildings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--overrides", help="seating overrides CSV (default overrides/<city>_seating.csv); "
                    "accepts lat,lng,type,height_m or the test-set columns observed_seating_lat/lng, seating_side")
    ap.add_argument("--out", default="out", help="output folder name under data/<city>/ (default: out)")
    ap.add_argument("--district-hint", action="store_true",
                    help="use the venue's postal district label (from enrichment) to split same-name OSM venues")
    args = ap.parse_args()
    t0 = time.time()
    city = load_city(args.city)
    dd = city_data_dir(args.city)
    out_dir = os.path.join(dd, args.out); os.makedirs(out_dir, exist_ok=True)
    hcfg, zcfg = city["heights"], city["horizon"]
    proj = LocalProjection(*city["origin"])

    venues = json.load(open(os.path.join(dd, "venues.json")))
    ext = json.load(open(os.path.join(dd, "osm", "osm_extract.json")))
    lidar = load_lidar(city)
    existing = {}
    ep = os.path.join(dd, "existing_seating.json")
    if os.path.exists(ep):
        existing = {r["place_id"]: r for r in json.load(open(ep))}
    overrides = {}
    op = args.overrides or os.path.join(HERE, "overrides", f"{args.city}_seating.csv")
    if os.path.exists(op):
        for r in csv.DictReader(line for line in open(op) if not line.startswith("#")):
            lat = r.get("lat") or r.get("observed_seating_lat")
            lng = r.get("lng") or r.get("observed_seating_lng")
            if not (lat and lng) or r["place_id"] in overrides:
                continue
            overrides[r["place_id"]] = {"lat": lat, "lng": lng,
                                        "type": r.get("type") or r.get("seating_side") or "unknown",
                                        "height_m": r.get("height_m") or 0}
    log(f"{len(venues)} venues, {len(ext['pois'])} OSM POIs, {len(ext.get('places', []))} places, {len(ext['buildings'])} buildings, "
        f"{len(existing)} existing seating rows, {len(overrides)} manual overrides")

    matches = match_venues(venues, ext, proj, use_district_hint=args.district_hint)
    mstat = Counter(r["status"] for r in matches.values())
    log("match results:", dict(mstat))

    # Venue anchor points (local metres)
    anchors = {}
    for v in venues:
        pid = v["place_id"]
        prot = existing.get(pid)
        if pid in overrides:
            o = overrides[pid]
            anchors[pid] = ("override", proj.fwd(float(o["lng"]), float(o["lat"])))
        elif prot and prot.get("seating_source") in PROTECTED_SOURCES:
            anchors[pid] = ("protected", proj.fwd(prot["seating_lng"], prot["seating_lat"]))
        elif matches[pid]["status"] == "matched":
            p = matches[pid]["poi"]
            anchors[pid] = ("poi", proj.fwd(p["lon"], p["lat"]))

    # Keep only OSM features near venues (R + margin)
    keep_r = zcfg["ray_length_m"] + 100
    cell = 500.0
    cells = {(int(x // cell), int(y // cell)) for _, (x, y) in anchors.values()}
    near = {(cx + i, cy + j) for cx, cy in cells for i in (-1, 0, 1) for j in (-1, 0, 1)}

    def near_any(coords):
        x, y = proj.fwd(*coords[0])
        return (int(x // cell), int(y // cell)) in near

    buildings, heights = [], []
    for b in ext["buildings"]:
        if not near_any(b["coords"]):
            continue
        xy = [proj.fwd(lon, lat) for lon, lat in b["coords"]]
        poly = Polygon(xy)
        if not poly.is_valid:
            poly = poly.buffer(0)
            if poly.geom_type == "MultiPolygon":
                poly = max(poly.geoms, key=lambda g: g.area)
        if poly.is_empty or poly.area < 2:
            continue
        buildings.append({"id": b["id"], "part": b["part"], "poly": poly, "osm": b})
        heights.append(resolve_height(b, lidar, hcfg))
    streets = []
    for s in ext["streets"]:
        if near_any(s["coords"]):
            streets.append({"id": s["id"], "name": s["name"], "line": LineString([proj.fwd(*c) for c in s["coords"]])})
    log(f"{len(buildings)} buildings and {len(streets)} streets within {keep_r:.0f} m of venues")
    world = World(buildings, streets, heights)

    # LiDAR vs OSM disagreements
    dis = []
    for bd, (h, rule, osm) in zip(buildings, heights):
        lh = lidar.get(bd["id"].split("#")[0])
        if lh is not None and osm is not None and not bd["part"]:
            if abs(lh - osm) > max(hcfg["lidar_disagree_abs_m"], hcfg["lidar_disagree_rel"] * osm):
                dis.append((bd["id"], round(lh, 1), round(osm, 1),
                            "osm_height" if bd["osm"].get("height") else "levels", rule))

    seating_rows, profile_rows, fix_rows = [], [], []
    failures = Counter()
    extract_date = ext["osm_timestamp"]
    for v in venues:
        pid = v["place_id"]
        tags = {k.lower(): n for k, n in (v.get("tags") or {}).items()}
        m = matches[pid]
        a = anchors.get(pid)
        if a is None:
            fix_rows.append([pid, v["name"], m["status"], "; ".join(c or "?" for c in m.get("candidates", []))])
            continue
        kind, (ax, ay) = a
        seat_h = 0.0
        exclude = None
        if kind in ("override", "protected"):
            src = overrides.get(pid) or existing[pid]
            seat_type = src.get("type") or src.get("seating_type") or "unknown"
            seat_h = float(src.get("height_m") or src.get("seating_height_m") or 0)
            sx, sy = ax, ay
            if seat_type == "rooftop" and seat_h == 0:
                bi, _ = world.building_for("", sx, sy)
                if bi is not None:
                    seat_h, exclude = world.H[bi], bi
            elif seat_type == "rooftop":
                bi, _ = world.building_for("", sx, sy)
                exclude = bi
            row = {"place_id": pid, "seating_source": "manual" if kind == "override" else src["seating_source"],
                   "seating_type": seat_type, "seating_confidence": "high", "match_method": "manual",
                   "match_score": None, "osm_building_id": None, "osm_poi_id": None}
        else:
            poi = m["poi"]
            bi, how = world.building_for(poi["id"], ax, ay)
            roof = bool(v.get("rooftop_attr")) or any(t in tags for t in ROOF_TAGS)
            rear_n = sum(tags.get(t, 0) for t in REAR_TAGS)
            source = "enrichment" if (roof or rear_n) else "auto"
            if bi is None:
                sx, sy, seat_type, conf, place_how = ax, ay, "unknown", "low", "poi_point"
            elif roof:
                rp = world.polys[bi].representative_point()
                sx, sy, seat_type = rp.x, rp.y, "rooftop"
                seat_h, exclude = world.H[bi], bi
                conf = "medium" if v.get("rooftop_attr") else "low"
                place_how = "roof_centre"
            else:
                mode = "rear" if rear_n else "front"
                pt, place_how = world.place_seating(bi, (ax, ay), mode, zcfg["seat_offset_m"])
                if pt is None:
                    sx, sy, seat_type, conf = ax, ay, "unknown", "low"
                else:
                    sx, sy = pt
                    seat_type = "rear" if place_how == "rear_edge" else "front"
                    strong = m["method"] == "name_exact" and how in ("poi_inside", "poi_is_building")
                    if seat_type == "rear":
                        conf = "medium" if rear_n >= 3 and strong else "low"
                    else:
                        conf = "medium" if strong and not rear_n else "low"
            row = {"place_id": pid, "seating_source": source, "seating_type": seat_type,
                   "seating_confidence": conf, "match_method": m["method"], "match_score": m["score"],
                   "osm_building_id": buildings[bi]["id"].split("#")[0] if bi is not None else None,
                   "osm_poi_id": poi["id"], "placement": place_how, "building_link": how}
        lon, lat = proj.inv(sx, sy)
        row.update({"city": city["name"], "seating_lat": round(lat, 7), "seating_lng": round(lon, 7),
                    "seating_height_m": round(float(seat_h), 1)})
        seating_rows.append(row)

        try:
            hz, hit = world.horizon(sx, sy, seat_h + zcfg["eye_height_m"], zcfg["ray_length_m"], exclude)
        except Exception as e:  # noqa: BLE001 — log and keep going
            failures[type(e).__name__] += 1
            continue
        rules = Counter(heights[i][1] for i in hit)
        total = sum(rules.values())
        real = total - rules.get("default", 0)
        profile_rows.append({
            "place_id": pid, "city": city["name"],
            "horizon": [int(round(d * 10)) for d in hz],
            "data_quality": round(real / total, 3) if total else 0.0,
            "buildings_total": total, "buildings_lidar": rules.get("lidar", 0),
            "buildings_osm_height": rules.get("osm_height", 0), "buildings_levels": rules.get("levels", 0),
            "buildings_default": rules.get("default", 0),
            "ray_length_m": zcfg["ray_length_m"], "eye_height_m": zcfg["eye_height_m"],
            "osm_extract_date": extract_date,
            "lidar_source": city["lidar"]["name"] if rules.get("lidar") else None,
            "algorithm_version": ALGORITHM_VERSION,
        })

    json.dump(seating_rows, open(os.path.join(out_dir, "seating.json"), "w"), indent=0)
    json.dump(profile_rows, open(os.path.join(out_dir, "profiles.json"), "w"), separators=(",", ":"))
    with open(os.path.join(out_dir, "manual_fix_list.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["place_id", "name", "reason", "osm_candidates"]); w.writerows(fix_rows)
    with open(os.path.join(out_dir, "lidar_disagreements.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["osm_id", "lidar_height_m", "osm_height_m", "osm_rule", "rule_used"]); w.writerows(dis)
    dq = [p["data_quality"] for p in profile_rows]
    summary = {
        "city": city["name"], "algorithm_version": ALGORITHM_VERSION, "osm_extract_date": extract_date,
        "venues_considered": len(venues), "venues_matched": len(anchors),
        "venues_processed": len(profile_rows), "venues_failed": sum(failures.values()),
        "failures": dict(failures), "match_status": dict(mstat),
        "seating_types": dict(Counter(r["seating_type"] for r in seating_rows)),
        "seating_confidence": dict(Counter(r["seating_confidence"] for r in seating_rows)),
        "avg_data_quality": round(sum(dq) / len(dq), 3) if dq else None,
        "lidar_disagreements": len(dis), "lidar_buildings_loaded": len(lidar),
        "height_rules_nearby": dict(Counter(h[1] for h in heights)),
        "params": {"heights": hcfg, "horizon": zcfg, "match_accept": MATCH_ACCEPT,
                   "district_hint": args.district_hint},
        "seconds": round(time.time() - t0, 1),
    }
    json.dump(summary, open(os.path.join(out_dir, "run_summary.json"), "w"), indent=2)
    log(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
