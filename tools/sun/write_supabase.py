"""Step 6 — write seating points, horizon profiles and the run summary to Supabase.

  python tools/sun/write_supabase.py --city dublin --sql-out     # SQL batch files (for the SQL editor / MCP)
  SUPABASE_ACCESS_TOKEN=... python tools/sun/write_supabase.py --city dublin --rpc

Guarantees, enforced in the SQL itself so they hold however it is run:
  * seating rows whose seating_source is 'manual' or 'venue' are never overwritten;
  * a horizon profile is written only if the stored seating point is the one it
    was computed from (so a stale run can't attach a profile to a manual point).
Re-running is safe: everything is an upsert keyed on place_id.
"""
import argparse
import glob
import json
import os
import sys
import urllib.request

from common import city_data_dir

BATCH = 80
SUPABASE_URL = "https://ivylljoqjswkuyrpevmg.supabase.co"


def q(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def seating_sql(rows):
    cols = ["place_id", "city", "seating_lat", "seating_lng", "seating_type", "seating_source",
            "seating_confidence", "seating_height_m", "osm_building_id", "osm_poi_id", "match_method", "match_score"]
    vals = ",\n".join("(" + ",".join(q(r.get(c)) for c in cols) + ")" for r in rows)
    upd = ", ".join(f"{c} = excluded.{c}" for c in cols[1:]) + ", updated_at = now()"
    return (f"insert into public.venue_seating ({', '.join(cols)}) values\n{vals}\n"
            f"on conflict (place_id) do update set {upd}\n"
            f"where public.venue_seating.seating_source not in ('manual','venue');\n")


def profile_sql(rows, seat_by_id):
    """Per-run constants (city, ray, eye, extract date, LiDAR source, version)
    go in the SELECT once; each row carries only what varies."""
    const_keys = ["city", "ray_length_m", "eye_height_m", "osm_extract_date", "algorithm_version"]
    consts = {k: rows[0][k] for k in const_keys}
    assert all(r[k] == consts[k] for r in rows for k in const_keys), "mixed runs in one batch"
    lidar_names = {r["lidar_source"] for r in rows if r.get("lidar_source")}
    assert len(lidar_names) <= 1
    lidar_name = next(iter(lidar_names), None)
    var = ["place_id", "horizon", "data_quality", "buildings_total", "buildings_lidar",
           "buildings_osm_height", "buildings_levels", "buildings_default"]
    vals = []
    for r in rows:
        s = seat_by_id[r["place_id"]]
        h = "'{" + ",".join(str(int(x)) for x in r["horizon"]) + "}'"
        vals.append(f"({q(r['place_id'])},{h},{r['data_quality']},{r['buildings_total']},{r['buildings_lidar']},"
                    f"{r['buildings_osm_height']},{r['buildings_levels']},{r['buildings_default']},"
                    f"{s['seating_lat']},{s['seating_lng']})")
    cols = var + ["city", "ray_length_m", "eye_height_m", "osm_extract_date", "lidar_source", "algorithm_version"]
    sel = (", ".join(f"v.{c}" for c in var if c != "horizon").replace("v.place_id", "v.place_id, v.horizon::smallint[]")
           + f", {q(consts['city'])}, {consts['ray_length_m']}, {consts['eye_height_m']}, "
           f"{q(consts['osm_extract_date'])}::timestamptz, "
           f"case when v.buildings_lidar > 0 then {q(lidar_name)} end, {q(consts['algorithm_version'])}")
    upd = ", ".join(f"{c} = excluded.{c}" for c in cols[1:]) + ", computed_at = now()"
    return (f"insert into public.venue_sun_profile ({', '.join(cols)})\n"
            f"select {sel} from (values\n" + ",\n".join(vals) + f"\n) as v({', '.join(var)}, lat, lng)\n"
            f"join public.venue_seating s on s.place_id = v.place_id\n"
            f"  and abs(s.seating_lat - v.lat) < 1e-6 and abs(s.seating_lng - v.lng) < 1e-6\n"
            f"on conflict (place_id) do update set {upd};\n")


def run_sql(summary):
    keys = ["city", "algorithm_version", "osm_extract_date", "venues_considered", "venues_matched",
            "venues_processed", "venues_failed", "avg_data_quality", "lidar_disagreements"]
    extra = {k: v for k, v in summary.items() if k not in keys and k != "params"}
    return (f"insert into public.sun_pipeline_runs ({', '.join(keys)}, params, summary, finished_at) values ("
            + ", ".join(q(summary.get(k)) for k in keys)
            + f", {q(json.dumps(summary.get('params')))}::jsonb, {q(json.dumps(extra))}::jsonb, now());\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--sql-out", action="store_true", help="write SQL batch files to data/<city>/out/sql/")
    mode.add_argument("--rpc", action="store_true", help="execute via the Supabase Management API (personal access token)")
    args = ap.parse_args()
    out = os.path.join(city_data_dir(args.city), "out")
    seating = json.load(open(os.path.join(out, "seating.json")))
    profiles = json.load(open(os.path.join(out, "profiles.json")))
    summary = json.load(open(os.path.join(out, "run_summary.json")))
    seat_by_id = {r["place_id"]: r for r in seating}

    stmts = []
    for i in range(0, len(seating), BATCH):
        stmts.append(("seating", seating_sql(seating[i:i + BATCH])))
    for i in range(0, len(profiles), BATCH):
        stmts.append(("profiles", profile_sql(profiles[i:i + BATCH], seat_by_id)))
    stmts.append(("run", run_sql(summary)))

    if args.sql_out:
        d = os.path.join(out, "sql")
        os.makedirs(d, exist_ok=True)
        for f in glob.glob(os.path.join(d, "*.sql")):
            os.remove(f)
        for n, (kind, sql) in enumerate(stmts):
            with open(os.path.join(d, f"{n:03d}_{kind}.sql"), "w") as f:
                f.write(sql)
        print(f"[write] {len(stmts)} SQL files -> {d}", file=sys.stderr)
        return

    # The guarded upserts are plain SQL, so run them through the Management API
    # query endpoint with a Supabase personal access token (never commit it).
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    ref = SUPABASE_URL.split("//")[1].split(".")[0]
    if not token:
        sys.exit("SUPABASE_ACCESS_TOKEN (personal access token) is required for --rpc")
    for kind, sql in stmts:
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{ref}/database/query",
            data=json.dumps({"query": sql}).encode(), method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
        print(f"[write] {kind}: ok", file=sys.stderr)


if __name__ == "__main__":
    main()
