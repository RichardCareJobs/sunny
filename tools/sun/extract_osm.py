"""Step 1 — extract buildings, streets and hospitality POIs from an OSM extract.

Usage:
  python tools/sun/extract_osm.py --city dublin

Reads  tools/sun/data/<city>/osm/<city extract>.osm.pbf  (see cities/<city>.json)
Writes tools/sun/data/<city>/osm/osm_extract.json

Everything here is OpenStreetMap data (© OpenStreetMap contributors, ODbL).
"""
import argparse
import json
import os
import sys

import osmium

from common import load_city, city_data_dir

STREET_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "living_street", "pedestrian", "road",
    "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}
POI_AMENITIES = {"pub", "bar", "restaurant", "cafe", "nightclub", "biergarten", "fast_food"}
PLACE_TYPES = {"suburb", "neighbourhood", "quarter", "village", "town", "locality"}
NAME_KEYS = ("name", "name:en", "alt_name", "old_name", "official_name", "short_name", "brand")


def in_bbox(lon, lat, bb):
    return bb[1] <= lon <= bb[3] and bb[0] <= lat <= bb[2]


def num(v):
    """Parse an OSM numeric tag like '12', '12.5 m', '12;14'. Returns float or None."""
    if v is None:
        return None
    s = str(v).split(";")[0].strip().lower().replace(",", ".")
    for unit in ("metres", "meters", "metre", "meter", "m"):
        if s.endswith(unit):
            s = s[: -len(unit)].strip()
            break
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f >= 0 else None


class Handler(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.buildings = []
        self.streets = []
        self.pois = []
        self.places = []
        self.postcodes = []

    def _poi(self, kind, oid, tags, lon, lat):
        amenity = tags.get("amenity")
        if not (amenity in POI_AMENITIES or tags.get("tourism") == "hotel"):
            return
        names = {k: tags.get(k) for k in NAME_KEYS if tags.get(k)}
        if not names or not in_bbox(lon, lat, self.bbox):
            return
        self.pois.append({
            "id": f"{kind}/{oid}", "names": names,
            "amenity": amenity or "hotel",
            "lon": round(lon, 7), "lat": round(lat, 7),
            "addr": {k[5:]: tags.get(k) for k in ("addr:housenumber", "addr:street", "addr:postcode") if tags.get(k)},
        })

    def _postcode(self, tags, lon, lat):
        pc = tags.get("addr:postcode")
        if pc and in_bbox(lon, lat, self.bbox):
            self.postcodes.append([round(lon, 6), round(lat, 6), pc.strip().upper()[:3]])

    def node(self, n):
        if not n.location.valid():
            return
        t = n.tags
        lon, lat = n.location.lon, n.location.lat
        self._poi("node", n.id, t, lon, lat)
        self._postcode(t, lon, lat)
        if t.get("place") in PLACE_TYPES and t.get("name") and in_bbox(lon, lat, self.bbox):
            self.places.append({"name": t.get("name"), "type": t.get("place"), "lon": round(lon, 6), "lat": round(lat, 6)})

    def way(self, w):
        hw = w.tags.get("highway")
        if hw in STREET_TYPES:
            try:
                coords = [[round(nd.lon, 7), round(nd.lat, 7)] for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(coords) >= 2 and any(in_bbox(c[0], c[1], self.bbox) for c in coords):
                self.streets.append({"id": f"way/{w.id}", "type": hw, "name": w.tags.get("name"), "coords": coords})

    def area(self, a):
        tags = a.tags
        is_building = tags.get("building", "no") != "no"
        is_part = tags.get("building:part", "no") != "no"
        oid = f"{'way' if a.from_way() else 'relation'}/{a.orig_id()}"
        if is_building or is_part:
            for i, outer in enumerate(a.outer_rings()):
                try:
                    ring = [[round(nd.lon, 7), round(nd.lat, 7)] for nd in outer]
                except osmium.InvalidLocationError:
                    continue
                if len(ring) < 4 or not any(in_bbox(c[0], c[1], self.bbox) for c in ring):
                    continue
                self.buildings.append({
                    "id": oid if i == 0 else f"{oid}#{i}",
                    "part": is_part and not is_building,
                    "building": tags.get("building") or tags.get("building:part"),
                    "height": num(tags.get("height")),
                    "min_height": num(tags.get("min_height")),
                    "levels": num(tags.get("building:levels")),
                    "roof_levels": num(tags.get("roof:levels")),
                    "coords": ring,
                })
        # Venues mapped as building/area outlines (common for pubs)
        if a.num_rings()[0] > 0:
            try:
                ring = list(a.outer_rings())[0]
                lon = sum(nd.lon for nd in ring) / len(ring)
                lat = sum(nd.lat for nd in ring) / len(ring)
            except (osmium.InvalidLocationError, ZeroDivisionError):
                return
            self._poi(oid.split("/")[0], a.orig_id(), tags, lon, lat)
            self._postcode(tags, lon, lat)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    args = ap.parse_args()
    city = load_city(args.city)
    osm_dir = os.path.join(city_data_dir(args.city), "osm")
    pbf = os.path.join(osm_dir, city["osm_extract"]["file"])
    reader = osmium.io.Reader(pbf, osmium.osm.osm_entity_bits.NOTHING)
    header = reader.header()
    stamp = header.get("osmosis_replication_timestamp") or None
    reader.close()

    h = Handler(city["bbox"])
    h.apply_file(pbf, locations=True)
    out = {
        "city": args.city,
        "source": city["osm_extract"]["url"],
        "osm_timestamp": stamp,
        "bbox": city["bbox"],
        "buildings": h.buildings,
        "streets": h.streets,
        "pois": h.pois,
        "places": h.places,
        "postcodes": h.postcodes,
    }
    path = os.path.join(osm_dir, "osm_extract.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[extract] {args.city}: {len(h.buildings)} buildings, {len(h.streets)} streets, "
          f"{len(h.pois)} POIs, {len(h.places)} places, {len(h.postcodes)} postcodes, OSM data as of {stamp} -> {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
