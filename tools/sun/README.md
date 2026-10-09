# Sun pipeline

Pre-computes, per venue, a seating point and a 72-direction **horizon profile**
(skyline elevation every 5° of azimuth). The app checks sun vs skyline live in
the browser (`js/sun-core.js`), so nothing time-dependent is stored.

City is a parameter: everything city-specific is in `cities/<city>.json`.

## Data and licences

| Data | Source | Licence | Used for |
|---|---|---|---|
| Buildings, streets, pubs | OpenStreetMap via BBBike extract | ODbL — "© OpenStreetMap contributors" | footprints, heights, seating points |
| Building heights (city centre) | 2015 Aerial Laser and Photogrammetry Survey of Dublin City, Laefer et al., NYU | CC BY 4.0 | heights where it covers |
| Venue name, district, enrichment tags | Sunny (`venue_details`, `venue_attributes`, `venue_enrichment`) | — | finding the OSM venue; front/rear/rooftop hints |
| Cloud / direct sun | Open-Meteo (browser, live) | CC BY 4.0 | "sun hidden by cloud" |

No Google coordinates or Google map content are used in any calculation.
Venue names are only used to find the matching OSM feature.

## Run (Dublin)

```bash
python3 -m venv tools/sun/.venv
tools/sun/.venv/bin/pip install osmium shapely numpy pyproj "laspy[lazrs]"
cd tools/sun

# 0. Inputs (gitignored, under data/dublin/):
#    data/dublin/osm/Dublin.osm.pbf     https://download.bbbike.org/osm/bbbike/Dublin/Dublin.osm.pbf
#    data/dublin/venues.json            output of export_venues.sql (run in the Supabase SQL editor)
#    data/dublin/existing_seating.json  optional: current venue_seating rows (manual/venue rows are kept)
../.venv/bin/python extract_osm.py --city dublin          # 1. OSM -> osm_extract.json (~2 min)
../.venv/bin/python lidar_heights.py --city dublin        # 2a. LiDAR, one tile at a time, raw tiles deleted (~40 min)
../.venv/bin/python build_profiles.py --city dublin       # 2–5. match, heights, seating, horizons (~30 s)
../.venv/bin/python coverage.py --city dublin             # coverage report -> reports/
../.venv/bin/python write_supabase.py --city dublin --sql-out   # 6. guarded upserts as SQL files
node accuracy.js --city dublin --test testsets/dublin_test_set.csv  # accuracy report -> reports/
```

`derived/lidar_heights_dublin_2015.csv` (one height per OSM building) is the
only LiDAR product kept; it's committed so step 2a never needs re-running.

## Method

* **Heights**, in priority order: LiDAR (p90 of returns inside the footprint
  eroded 1 m, minus the p20 of a minimum-height grid in a 3–10 m ring outside)
  → OSM `height` → `building:levels` × 3.29 m + 3.9 m (+ `roof:levels` × 1.5 m)
  → 12 m. The storey rule is calibrated against the LiDAR (3,054 Dublin
  buildings with both): typical error 1.6 m, versus 4.2 m for a plain × 3 m.
  An explicit OSM `height` well above the LiDAR value wins (built since 2015).
  LiDAR/OSM disagreements over max(3 m, 25%) are listed in
  `out/lidar_disagreements.csv`.
* **Matching**: venue name vs OSM pub/bar/restaurant/café/hotel names in the
  city box. Generic words (pub, bar, lounge…) are weak; "X of Rathmines" /
  "X Clontarf" use OSM place names to pick between same-named venues. Ties
  far apart go to `out/manual_fix_list.csv`. `--district-hint` additionally
  uses the venue's postal district label against OSM Eircode routing keys.
* **Seating**: just outside (2.5 m) the footprint edge facing the nearest named
  street, at the point nearest the OSM venue; party walls are skipped.
  Enrichment tags move it to the rear edge (beer garden, courtyard, back
  garden) or the roof (rooftop attribute / roof terrace). Rows with
  `seating_source` `manual` or `venue` are never overwritten.
* **Horizon**: rays every 5° out to 300 m; highest angle to any building top
  above eye height (1.2 m seated; roof + 1.2 m for rooftops, own building
  excluded). Floored at 0°.
* **Data quality**: share of buildings hit by the rays that have a real height
  (LiDAR, OSM height or storeys) rather than the 12 m default.

## Manual fixes

Add rows to `overrides/<city>_seating.csv` (`place_id,lat,lng,type,height_m`)
and re-run `build_profiles.py`; they're written with `seating_source = manual`.
