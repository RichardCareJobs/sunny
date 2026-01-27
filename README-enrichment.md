
# Sunny v2.8 — Enrichment (Foursquare + Wikidata)

## Setup (static hosting)
- Deploy the site to any static host (e.g. GitHub Pages). The map and core experience work without any server components.
- Hours/phone/website enrichment is optional. If you skip it the UI quietly falls back to the Google Places data.

## Optional enrichment endpoint
1. Host an HTTPS endpoint that implements the same contract as the former Netlify function (accepts `name`, `lat`, `lon`, `wikidata`, `osm_id` query params and returns enrichment JSON).
   - The reference implementation previously lived in `netlify/functions/enrich.js` and expects `FOURSQUARE_API_KEY`.
2. Before loading `app.js`, set `window.SUNNY_ENRICH_ENDPOINT` to that endpoint, for example:
   ```html
   <script>window.SUNNY_ENRICH_ENDPOINT = 'https://example.com/api/enrich';</script>
   ```

With `SUNNY_ENRICH_ENDPOINT` unset, enrichment requests are skipped.

## How it works
- Client calls `<SUNNY_ENRICH_ENDPOINT>?name=<>&lat=<>&lon=<>&wikidata=<id>&osm_id=<id>` lazily (on detail open and for the first few visible cards).
- Responses are cached in `localStorage` under `sunny:enrich:<venueId>` for 7 days.
- When present, hours/phone/website/photos are merged into the card + detail view, with a tiny attribution.

## Attribution
- “ⓘ data via Foursquare/Wikidata” appears on cards that use enrichment.
