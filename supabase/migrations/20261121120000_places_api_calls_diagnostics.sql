-- Diagnostic columns for places_api_calls, so we can see *why* each billed Google Places
-- request happened and which of the per-map-search passes are worth paying for.
-- Additive only: nullable columns and one index. No policy or grant changes; the public
-- key can still only insert (see supabase-setup.sql).
--
-- The client (app.js logPlacesApiCall) sends these fields when present and automatically
-- falls back to the original columns if this migration hasn't been applied yet.
--
--   reason      what triggered the call: initial | map_move | search_box | card_open |
--               photo_viewer | enrichment | qualification | crawl | saved_venue
--   pass_label  which pass of a map search: nearby | bar+beer garden |
--               restaurant+outdoor seating | club+sports club | fallback-text-pub | ...
--   tile_key    map search cell the call was made for (see js/tile-core.js)
--   zoom        map zoom level when the call was made
--   discarded   true when the result came back after the user had already moved on
--               (paid for, but not rendered; it is still cached)
--   unique_new  how many venues this pass returned that no other pass in the same
--               map search returned (measures each pass's marginal value)
--
-- Reports: docs/places_call_diagnostics.sql, docs/places_cost_reporting.sql

alter table public.places_api_calls
  add column if not exists reason text,
  add column if not exists pass_label text,
  add column if not exists tile_key text,
  add column if not exists zoom smallint,
  add column if not exists discarded boolean,
  add column if not exists unique_new integer;

create index if not exists idx_places_api_calls_created_at
  on public.places_api_calls (created_at);
