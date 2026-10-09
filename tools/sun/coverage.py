"""Coverage report: which venues have a sun profile, and how good the heights are.

  python tools/sun/coverage.py --city dublin [--unplaced N]

Writes tools/sun/reports/<city>_coverage_<date>.md
--unplaced: venues in venue_details with no city label, which the pipeline
cannot place in any city (reported, not processed).
"""
import argparse
import csv
import json
import os
import time
from collections import Counter

from common import HERE, city_data_dir, load_city


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "–"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--unplaced", type=int, default=None)
    args = ap.parse_args()
    city = load_city(args.city)
    out = os.path.join(city_data_dir(args.city), "out")
    summary = json.load(open(os.path.join(out, "run_summary.json")))
    profiles = json.load(open(os.path.join(out, "profiles.json")))
    seating = {r["place_id"]: r for r in json.load(open(os.path.join(out, "seating.json")))}
    fixes = list(csv.DictReader(open(os.path.join(out, "manual_fix_list.csv"))))
    dis = list(csv.DictReader(open(os.path.join(out, "lidar_disagreements.csv"))))

    n_v = summary["venues_considered"]
    n_p = len(profiles)
    rules = Counter()
    for p in profiles:
        rules["lidar"] += p["buildings_lidar"]; rules["osm_height"] += p["buildings_osm_height"]
        rules["levels"] += p["buildings_levels"]; rules["default"] += p["buildings_default"]
    tot = sum(rules.values())
    with_lidar = sum(1 for p in profiles if p["buildings_lidar"] > 0)
    dq = sorted(p["data_quality"] for p in profiles)
    bands = Counter("high (≥0.66)" if q >= 0.66 else "medium (0.33–0.66)" if q >= 0.33 else "low (<0.33)" for q in dq)

    L = []
    L.append(f"# Sun profile coverage — {city['name']} ({time.strftime('%Y-%m-%d')})\n")
    L.append(f"Algorithm `{summary['algorithm_version']}` · OSM data as of {summary['osm_extract_date']} · "
             f"LiDAR building heights loaded: {summary['lidar_buildings_loaded']:,}\n")
    L.append("## Venues\n")
    L.append("| | Venues | Share |\n|---|---|---|")
    L.append(f"| {city['name']} venues considered | {n_v} | 100% |")
    L.append(f"| Matched to an OSM venue | {summary['venues_matched']} | {pct(summary['venues_matched'], n_v)} |")
    L.append(f"| **With a sun profile** | **{n_p}** | **{pct(n_p, n_v)}** |")
    L.append(f"| Profile uses LiDAR heights | {with_lidar} | {pct(with_lidar, n_v)} |")
    L.append(f"| On the manual fix list | {len(fixes)} | {pct(len(fixes), n_v)} |")
    if args.unplaced is not None:
        L.append(f"\nNot processed: {args.unplaced:,} venues in `venue_details` have no city label (never enriched), "
                 f"so the pipeline can't tell which city they're in.")
    L.append("\nMatch outcomes: " + ", ".join(f"{k} {v}" for k, v in summary["match_status"].items()) +
             (" (postal-district tie-break on)" if summary["params"].get("district_hint") else " (name only)") + "\n")
    L.append("Manual fix list reasons: " + ", ".join(f"{k} {v}" for k, v in Counter(f["reason"] for f in fixes).items()) + "\n")

    L.append("## Building heights behind the profiles\n")
    L.append("Buildings counted are the ones the horizon rays actually hit, summed over all venues.\n")
    L.append("| Height source | Buildings | Share |\n|---|---|---|")
    for k, label in [("lidar", "2015 LiDAR"), ("osm_height", "OSM `height`"), ("levels", "OSM storeys (× 3.29 m + 3.9 m)"),
                     ("default", "Default 12 m (fallback)")]:
        L.append(f"| {label} | {rules[k]:,} | {pct(rules[k], tot)} |")
    L.append(f"\n**Real heights {pct(tot - rules['default'], tot)} · fallback {pct(rules['default'], tot)}.** "
             f"LiDAR vs OSM disagreements flagged (> max(3 m, 25%)): {len(dis)}.\n")
    L.append("## Data quality per venue\n")
    L.append("Share of the buildings shaping a venue's skyline that have a real height.\n")
    L.append("| Band | Venues |\n|---|---|")
    for b in ("high (≥0.66)", "medium (0.33–0.66)", "low (<0.33)"):
        L.append(f"| {b} | {bands.get(b, 0)} |")
    if dq:
        L.append(f"\nMedian {dq[len(dq) // 2]:.2f}, mean {sum(dq) / len(dq):.2f}.\n")
    L.append("## Seating points\n")
    L.append("| Type | Venues |\n|---|---|")
    for k, v in Counter(r["seating_type"] for r in seating.values()).most_common():
        L.append(f"| {k} | {v} |")
    L.append("\n| Confidence | Venues |\n|---|---|")
    for k, v in Counter(r["seating_confidence"] for r in seating.values()).most_common():
        L.append(f"| {k} | {v} |")
    L.append("\n| Source | Venues |\n|---|---|")
    for k, v in Counter(r["seating_source"] for r in seating.values()).most_common():
        L.append(f"| {k} | {v} |")

    rep = os.path.join(HERE, "reports")
    os.makedirs(rep, exist_ok=True)
    path = os.path.join(rep, f"{args.city}_coverage_{time.strftime('%Y-%m-%d')}.md")
    open(path, "w").write("\n".join(L) + "\n")
    print(path)


if __name__ == "__main__":
    main()
