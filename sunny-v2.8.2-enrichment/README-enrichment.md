
# Sunny v2.8 — Enrichment (Foursquare + Wikidata)

## Setup (Netlify)
1. Set environment variables in Netlify → Site settings → Build & deploy → Environment:
   - `FOURSQUARE_API_KEY` (required for Foursquare enrichment)
2. Deploy this folder. Netlify will expose the function at `/api/enrich`.

## How it works
- Client calls `/api/enrich?name=<>&lat=<>&lon=<>&wikidata=<id>&osm_id=<id>` lazily (on detail open and for the first few visible cards).
- Responses are cached in `localStorage` under `sunny:enrich:<venueId>` for 7 days.
- When present, hours/phone/website/photos are merged into the card + detail view, with a tiny attribution.

## Attribution
- “ⓘ data via Foursquare/Wikidata” appears on cards that use enrichment.
