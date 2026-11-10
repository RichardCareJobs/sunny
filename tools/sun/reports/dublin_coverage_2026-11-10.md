# Sun profile coverage — Dublin (2026-11-10)

Algorithm `horizon-v1` · OSM data as of 2026-11-07T00:00:00Z · LiDAR building heights loaded: 8,962

> Written to the database from this run: the 151 newly matched venues only. The 313 profiles from the
> 2026-10-09 run were left as they were, so the height and quality tables below (computed over all 464
> with November OSM data) differ slightly from what is stored for those 313. Candidates now include
> unlabelled venues with the Dublin place ID region code (see README).

## Venues

| | Venues | Share |
|---|---|---|
| Dublin venues considered | 804 | 100% |
| Matched to an OSM venue | 464 | 58% |
| **With a sun profile** | **464** | **58%** |
| Profile uses LiDAR heights | 196 | 24% |
| On the manual fix list | 340 | 42% |

Match outcomes: matched 464, unmatched 262, ambiguous 74, poi_conflict 4 (name only)

Manual fix list reasons: unmatched 262, ambiguous 74, poi_conflict 4

## Building heights behind the profiles

Buildings counted are the ones the horizon rays actually hit, summed over all venues.

| Height source | Buildings | Share |
|---|---|---|
| 2015 LiDAR | 58,832 | 31% |
| OSM `height` | 4,613 | 2% |
| OSM storeys (× 3.29 m + 3.9 m) | 34,632 | 18% |
| Default 12 m (fallback) | 91,882 | 48% |

**Real heights 52% · fallback 48%.** LiDAR vs OSM disagreements flagged (> max(3 m, 25%)): 378.

## Data quality per venue

Share of the buildings shaping a venue's skyline that have a real height.

| Band | Venues |
|---|---|
| high (≥0.66) | 170 |
| medium (0.33–0.66) | 110 |
| low (<0.33) | 184 |

Median 0.49, mean 0.51.

## Seating points

| Type | Venues |
|---|---|
| front | 419 |
| rear | 34 |
| rooftop | 10 |
| unknown | 1 |

| Confidence | Venues |
|---|---|
| medium | 400 |
| low | 64 |

| Source | Venues |
|---|---|
| auto | 420 |
| enrichment | 44 |
