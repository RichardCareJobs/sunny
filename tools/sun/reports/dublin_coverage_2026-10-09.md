# Sun profile coverage — Dublin (2026-10-09)

Algorithm `horizon-v1` · OSM data as of 2026-10-02T23:00:00Z · LiDAR building heights loaded: 8,962

## Venues

| | Venues | Share |
|---|---|---|
| Dublin venues considered | 496 | 100% |
| Matched to an OSM venue | 313 | 63% |
| **With a sun profile** | **313** | **63%** |
| Profile uses LiDAR heights | 139 | 28% |
| On the manual fix list | 183 | 37% |

Not processed: 1,521 venues in `venue_details` have no city label (never enriched), so the pipeline can't tell which city they're in.

Match outcomes: matched 313, unmatched 131, ambiguous 49, poi_conflict 3 (name only)

Manual fix list reasons: unmatched 131, ambiguous 49, poi_conflict 3

## Building heights behind the profiles

Buildings counted are the ones the horizon rays actually hit, summed over all venues.

| Height source | Buildings | Share |
|---|---|---|
| 2015 LiDAR | 39,167 | 29% |
| OSM `height` | 3,202 | 2% |
| OSM storeys (× 3.29 m + 3.9 m) | 23,366 | 17% |
| Default 12 m (fallback) | 70,728 | 52% |

**Real heights 48% · fallback 52%.** LiDAR vs OSM disagreements flagged (> max(3 m, 25%)): 377.

## Data quality per venue

Share of the buildings shaping a venue's skyline that have a real height.

| Band | Venues |
|---|---|
| high (≥0.66) | 103 |
| medium (0.33–0.66) | 73 |
| low (<0.33) | 137 |

Median 0.44, mean 0.49.

## Seating points

| Type | Venues |
|---|---|
| front | 268 |
| rear | 34 |
| rooftop | 10 |
| unknown | 1 |

| Confidence | Venues |
|---|---|
| medium | 273 |
| low | 40 |

| Source | Venues |
|---|---|
| auto | 269 |
| enrichment | 44 |
