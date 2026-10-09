"""Step 2a — per-building heights from the 2015 Dublin aerial LiDAR (NYU, CC BY 4.0).

Processes one 500 m tile at a time: download -> bin points -> update a small
running state -> delete the raw tile. Only the final per-building CSV is kept.

  python tools/sun/lidar_heights.py --city dublin               # all remaining tiles, then finalise
  python tools/sun/lidar_heights.py --city dublin --tiles 316000_234000
  python tools/sun/lidar_heights.py --city dublin --finalise-only

Classes in this survey: 2 = hard surfaces (ground AND roofs), 4 = vegetation.
So classification is used only to drop vegetation and noise.

Method (per OSM building, ways/relations tagged building=*, not building:part):
  roof   = 90th percentile of non-vegetation returns inside the footprint
           eroded 1 m inward (avoids walls, eaves and overhanging trees);
           needs >= MIN_POINTS returns.
  ground = 20th percentile of a 2 m minimum-height grid over a 3–10 m ring
           outside the footprint, excluding cells inside any building
           (streets and yards; the low percentile ignores parked cars).
  height = roof - ground.
Running state is exact under tile splits: per-building 0.1 m height histograms
add up and per-cell minimums combine across tiles.

Alignment: checked on tile 316000_234000 by FFT cross-correlation of elevated
returns against OSM footprints (EPSG:4326 -> EPSG:29902, TM65 7-parameter
Helmert): best offset 0.0 m at 0.5 m resolution.
"""
import argparse
import csv
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile

import laspy
import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import Polygon

from common import load_city, city_data_dir

Z_MIN, Z_MAX, Z_BIN = -5.0, 155.0, 0.1
N_BINS = int((Z_MAX - Z_MIN) / Z_BIN)
LABEL_RES = 0.5      # m, footprint label raster per tile
DEM_RES = 2.0        # m, ground DEM
TILE = 500.0
MIN_POINTS = 20
ERODE_M = 1.0
RING_IN, RING_OUT = 3.0, 10.0
VEG_CLASSES = (3, 4, 5)
NOISE_CLASSES = (7, 18)
GROUND_PCTL = 20
UA = {"User-Agent": "SunnyPubs-sun-pipeline/1.0"}


def log(*a):
    print("[lidar]", *a, file=sys.stderr, flush=True)


def tile_urls(city, work):
    idx = os.path.join(work, "all_bitstreams.json")
    if not os.path.exists(idx):
        req = urllib.request.Request(city["lidar"]["index_url"], headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r, open(idx, "wb") as f:
            f.write(r.read())
    urls = json.load(open(idx))["LAZ (Point-cloud)"]
    out = {}
    for u in urls:
        name = u.rsplit("/", 1)[-1]
        if "_pc_T_" not in name:
            continue
        key = name.split("_pc_T_")[1].replace(".zip", "").replace("-", "_")
        out[key] = u
    return dict(sorted(out.items()))


def tile_origin(key):
    x, y = key.split("_")
    return float(x), float(y)


def load_buildings(city, keys, to_grid):
    """OSM building footprints overlapping the LiDAR tiles, in Irish Grid metres."""
    ext = osm_extract(city)
    xs = [tile_origin(k)[0] for k in keys]
    ys = [tile_origin(k)[1] for k in keys]
    gx0, gy0, gx1, gy1 = min(xs), min(ys), max(xs) + TILE, max(ys) + TILE
    ids, polys = [], []
    for b in ext["buildings"]:
        if b["part"]:
            continue
        c = np.asarray(b["coords"])
        x, y = to_grid.transform(c[:, 0], c[:, 1])
        if x.max() < gx0 or x.min() > gx1 or y.max() < gy0 or y.min() > gy1:
            continue
        p = Polygon(np.column_stack([x, y]))
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty or p.area < 4:
            continue
        ids.append(b["id"])
        polys.append(p)
    return ids, polys, (gx0, gy0, gx1, gy1)


_ext_cache = {}


def osm_extract(city):
    key = city["name"]
    if key not in _ext_cache:
        path = os.path.join(city_data_dir(city["name"].lower()), "osm", "osm_extract.json")
        _ext_cache[key] = json.load(open(path))
    return _ext_cache[key]


def eroded(p):
    e = p.buffer(-ERODE_M)
    if e.is_empty or e.area < 1:
        e = p.buffer(-0.3)
    return e if not e.is_empty else p


class State:
    def __init__(self, path, n_buildings, extent):
        self.path = path
        gx0, gy0, gx1, gy1 = extent
        self.extent = extent
        self.dem_w = int(np.ceil((gx1 - gx0) / DEM_RES))
        self.dem_h = int(np.ceil((gy1 - gy0) / DEM_RES))
        if os.path.exists(path):
            z = np.load(path, allow_pickle=False)
            self.hist = z["hist"]
            self.dem_min = z["dem_min"]
            self.done = list(z["done"])
            assert self.hist.shape[0] == n_buildings, "building set changed; delete state to restart"
        else:
            self.hist = np.zeros((n_buildings, N_BINS), dtype=np.uint32)
            self.dem_min = np.full((self.dem_h, self.dem_w), np.inf, dtype=np.float32)
            self.done = []

    def save(self):
        tmp = self.path + ".tmp.npz"
        np.savez(tmp, hist=self.hist, dem_min=self.dem_min, done=np.array(self.done, dtype="U32"))
        os.replace(tmp, self.path)


def label_raster(key, polys_eroded, tree):
    """int32 raster (LABEL_RES) of building index for one tile, -1 elsewhere."""
    x0, y0 = tile_origin(key)
    n = int(TILE / LABEL_RES)
    lab = np.full((n, n), -1, dtype=np.int32)
    tile_box = shapely.box(x0, y0, x0 + TILE, y0 + TILE)
    for i in tree.query(tile_box):
        p = polys_eroded[i]
        bx0, by0, bx1, by1 = p.bounds
        c0 = max(0, int((bx0 - x0) / LABEL_RES)); c1 = min(n, int(np.ceil((bx1 - x0) / LABEL_RES)))
        r0 = max(0, int((by0 - y0) / LABEL_RES)); r1 = min(n, int(np.ceil((by1 - y0) / LABEL_RES)))
        if c1 <= c0 or r1 <= r0:
            continue
        cx = x0 + (np.arange(c0, c1) + 0.5) * LABEL_RES
        cy = y0 + (np.arange(r0, r1) + 0.5) * LABEL_RES
        X, Y = np.meshgrid(cx, cy)
        inside = shapely.contains_xy(p, X, Y)
        win = lab[r0:r1, c0:c1]
        win[inside] = i
    return lab


def process_tile(key, url, work, state, polys_eroded, tree, check_alignment=False):
    tdir = os.path.join(work, f"tile_{key}")
    os.makedirs(tdir, exist_ok=True)
    zpath = os.path.join(tdir, "tile.zip")
    t0 = time.time()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=1800) as r, open(zpath, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    size_mb = os.path.getsize(zpath) / 1e6
    with zipfile.ZipFile(zpath) as z:
        lazs = [n for n in z.namelist() if n.lower().endswith(".laz")]
        z.extractall(tdir, members=lazs)
    os.remove(zpath)
    log(f"{key}: downloaded {size_mb:.0f} MB in {time.time() - t0:.0f}s")

    lab = label_raster(key, polys_eroded, tree)
    x0, y0 = tile_origin(key)
    n = lab.shape[0]
    gx0, gy0 = state.extent[0], state.extent[1]
    shifts = [(dx, dy) for dx in np.arange(-3, 3.01, 0.5) for dy in np.arange(-3, 3.01, 0.5)] if check_alignment else []
    align_hits = np.zeros(len(shifts))
    npts = nbld = 0
    first_chunk = True
    for lz in lazs:
        with laspy.open(os.path.join(tdir, lz)) as fh:
            for pts in fh.chunk_iterator(5_000_000):
                X = np.asarray(pts.x); Y = np.asarray(pts.y); Z = np.asarray(pts.z)
                C = np.asarray(pts.classification)
                keep = ~np.isin(C, NOISE_CLASSES) & (Z > Z_MIN) & (Z < Z_MAX)
                X, Y, Z, C = X[keep], Y[keep], Z[keep], C[keep]
                npts += len(X)
                veg = np.isin(C, VEG_CLASSES)
                # minimum-height grid (ground candidates)
                dc = ((X - gx0) / DEM_RES).astype(np.int64)
                dr = ((Y - gy0) / DEM_RES).astype(np.int64)
                ok = (dc >= 0) & (dc < state.dem_w) & (dr >= 0) & (dr < state.dem_h)
                np.minimum.at(state.dem_min.reshape(-1), dr[ok] * state.dem_w + dc[ok], Z[ok].astype(np.float32))
                # roofs
                ng = ~veg
                Xn, Yn, Zn = X[ng], Y[ng], Z[ng]
                lc = ((Xn - x0) / LABEL_RES).astype(np.int64)
                lr = ((Yn - y0) / LABEL_RES).astype(np.int64)
                ok = (lc >= 0) & (lc < n) & (lr >= 0) & (lr < n)
                b = np.full(len(Xn), -1, dtype=np.int64)
                b[ok] = lab[lr[ok], lc[ok]]
                hit = b >= 0
                nbld += int(hit.sum())
                zb = ((Zn[hit] - Z_MIN) / Z_BIN).astype(np.int64)
                bins = np.bincount(b[hit] * N_BINS + zb, minlength=state.hist.size)
                state.hist += bins.reshape(state.hist.shape).astype(np.uint32)
                # alignment diagnostic: share of elevated returns that land on a footprint
                if first_chunk and shifts:
                    high = Zn > np.percentile(Zn, 60)
                    Xh, Yh = Xn[high], Yn[high]
                for si, (dx, dy) in enumerate(shifts if first_chunk else []):
                    sc = ((Xh - x0 + dx) / LABEL_RES).astype(np.int64)
                    sr = ((Yh - y0 + dy) / LABEL_RES).astype(np.int64)
                    o = (sc >= 0) & (sc < n) & (sr >= 0) & (sr < n)
                    align_hits[si] += int((lab[sr[o], sc[o]] >= 0).sum())
                first_chunk = False
    shutil.rmtree(tdir)
    state.done.append(key)
    state.save()
    log(f"{key}: {npts:,} points, {nbld:,} on footprints, {time.time() - t0:.0f}s total; raw tile deleted")
    if check_alignment:
        best = int(np.argmax(align_hits))
        zero = shifts.index((0.0, 0.0))
        log(f"{key}: alignment best shift (dx,dy)={shifts[best]} m hits={align_hits[best]:.0f} "
            f"vs zero-shift {align_hits[zero]:.0f} ({align_hits[zero] / max(1, align_hits[best]):.3f})")
        return shifts[best]
    return None


def finalise(state, ids, polys, tree, out_csv, lidar_name):
    dem = np.where(np.isfinite(state.dem_min), state.dem_min, np.nan)
    gx0, gy0 = state.extent[0], state.extent[1]
    centres = (np.arange(N_BINS) + 0.5) * Z_BIN + Z_MIN
    rows = []
    for i, bid in enumerate(ids):
        h = state.hist[i]
        cnt = int(h.sum())
        if cnt < MIN_POINTS:
            continue
        cum = np.cumsum(h)
        roof = float(centres[np.searchsorted(cum, 0.9 * cnt)])
        roof50 = float(centres[np.searchsorted(cum, 0.5 * cnt)])
        p = polys[i]
        ring = p.buffer(RING_OUT).difference(p.buffer(RING_IN))
        for j in tree.query(ring):
            if j != i:
                ring = ring.difference(polys[j])
        if ring.is_empty:
            continue
        bx0, by0, bx1, by1 = ring.bounds
        c0 = max(0, int((bx0 - gx0) / DEM_RES)); c1 = min(dem.shape[1], int(np.ceil((bx1 - gx0) / DEM_RES)))
        r0 = max(0, int((by0 - gy0) / DEM_RES)); r1 = min(dem.shape[0], int(np.ceil((by1 - gy0) / DEM_RES)))
        if c1 <= c0 or r1 <= r0:
            continue
        cx = gx0 + (np.arange(c0, c1) + 0.5) * DEM_RES
        cy = gy0 + (np.arange(r0, r1) + 0.5) * DEM_RES
        X, Y = np.meshgrid(cx, cy)
        inside = shapely.contains_xy(ring, X, Y)
        vals = dem[r0:r1, c0:c1][inside]
        vals = vals[np.isfinite(vals)]
        if len(vals) < 3:
            continue
        ground = float(np.percentile(vals, GROUND_PCTL))
        height = roof - ground
        if height < 2 or height > 120:
            continue
        rows.append((bid, round(height, 1), round(roof50 - ground, 1), round(ground, 2), cnt))
    with open(out_csv, "w", newline="") as f:
        f.write(f"# source: {lidar_name}; method: p90 roof - p20 ground ring; generated {time.strftime('%Y-%m-%d')}\n")
        w = csv.writer(f)
        w.writerow(["osm_id", "lidar_height_m", "lidar_p50_height_m", "ground_m", "n_points"])
        w.writerows(rows)
    log(f"finalised {len(rows)} building heights -> {out_csv}")
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--tiles", nargs="*", help="tile keys like 316000_234000 (default: all remaining)")
    ap.add_argument("--finalise-only", action="store_true")
    ap.add_argument("--no-finalise", action="store_true")
    args = ap.parse_args()
    city = load_city(args.city)
    work = os.path.join(city_data_dir(args.city), "lidar")
    os.makedirs(work, exist_ok=True)
    urls = tile_urls(city, work)
    to_grid = Transformer.from_crs("EPSG:4326", city["lidar"]["crs"], always_xy=True)
    ids, polys, extent = load_buildings(city, list(urls), to_grid)
    log(f"{len(urls)} tiles, {len(ids)} OSM buildings in LiDAR extent")
    tree = shapely.STRtree(polys)
    polys_eroded = [eroded(p) for p in polys]
    state = State(os.path.join(work, "state.npz"), len(ids), extent)

    if not args.finalise_only:
        todo = args.tiles or [k for k in urls if k not in state.done]
        for k in todo:
            if k in state.done:
                log(f"{k}: already processed, skipping")
                continue
            process_tile(k, urls[k], work, state, polys_eroded, tree, check_alignment=not state.done)
    if args.no_finalise:
        return
    out_csv = os.path.join(os.path.dirname(os.path.abspath(__file__)), "derived", city["lidar"]["heights_csv"])
    os.makedirs(os.path.dirname(out_csv), exist_ok=True)
    finalise(state, ids, polys, tree, out_csv, city["lidar"]["name"])
    if len(state.done) == len(urls):
        os.remove(state.path)
        log("all tiles processed; running state deleted")


if __name__ == "__main__":
    main()
