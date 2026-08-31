-- ═══════════════════════════════════════════════════════════════════════════
-- 20260831120000_venue_directory_columns
--
-- Gives venue_details the columns the venue platform's search and claim flows
-- actually need, and backfills them from venue_enrichment.
--
-- WHY
--   The brief assumes venue_details is a canonical directory holding a name,
--   an address and a publicly listed phone number. Today it holds none of the
--   last two: the address and phone live in venue_enrichment.raw, the JSONB
--   blob the Apify pipeline writes. Venue search (§3.1) cannot match on an
--   address it does not have, and phone verification (§3.2) is the sole gate
--   on claiming a venue, so the number it dials has to be a first-class,
--   queryable, auditable column — not a JSON path.
--
-- WHAT THIS IS NOT
--   This does not make venue_details canonical. It is still a cache, populated
--   when a consumer opens a venue: 87% of the venues seen in events over the
--   last 30 days have no row here at all. Fixing that needs a directory
--   backfill across Dublin and London, which is a separate job. This migration
--   makes the rows that DO exist usable.
--
-- SAFETY
--   Additive only. Every column is nullable, nothing is dropped or renamed,
--   and the consumer app's upsert path writes none of these columns, so it is
--   unaffected. Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.venue_details
  add column if not exists phone_e164           text,
  add column if not exists phone_source         text,
  add column if not exists formatted_address    text,
  add column if not exists street               text,
  add column if not exists postal_code          text,
  add column if not exists country_code         text,
  add column if not exists lat                  double precision,
  add column if not exists lng                  double precision,
  add column if not exists website              text,
  add column if not exists directory_source     text,
  add column if not exists directory_updated_at timestamptz;

comment on column public.venue_details.phone_e164 is
  'Publicly listed number in E.164, used by the claim verification call. Never '
  'user-supplied — a number the claimant can edit defeats the entire purpose of '
  'the step.';
comment on column public.venue_details.phone_source is
  'Where the number came from: apify | places | manual. Recorded because a '
  'claim dispute turns on which source we trusted.';
comment on column public.venue_details.country_code is
  'ISO-3166 alpha-2. Derives the venue currency (IE -> EUR, GB -> GBP) for '
  'plan pricing, so it is load-bearing beyond geography.';

-- ── Backfill from the enrichment blob ────────────────────────────────────────
-- Apify's `phoneUnformatted` is already E.164 (verified against the live data),
-- so no reformatting is needed — only a shape check. Anything that fails the
-- check is left null rather than guessed at: a wrong number here means calling
-- a stranger and handing a venue to whoever answers.
with latest as (
  select distinct on (place_id)
    place_id, raw
  from public.venue_enrichment
  where raw is not null
  order by place_id, scraped_at desc nulls last
)
update public.venue_details vd
set
  phone_e164 = case
    when nullif(latest.raw->>'phoneUnformatted', '') ~ '^\+[1-9][0-9]{7,14}$'
      then latest.raw->>'phoneUnformatted'
    else null
  end,
  phone_source = case
    when nullif(latest.raw->>'phoneUnformatted', '') ~ '^\+[1-9][0-9]{7,14}$'
      then 'apify'
    else null
  end,
  formatted_address    = coalesce(vd.formatted_address, nullif(latest.raw->>'address', '')),
  street               = coalesce(vd.street, nullif(latest.raw->>'street', '')),
  postal_code          = coalesce(vd.postal_code, nullif(latest.raw->>'postalCode', '')),
  country_code         = coalesce(vd.country_code, upper(nullif(latest.raw->>'countryCode', ''))),
  lat                  = coalesce(vd.lat, (latest.raw->'location'->>'lat')::double precision),
  lng                  = coalesce(vd.lng, (latest.raw->'location'->>'lng')::double precision),
  website              = coalesce(vd.website, nullif(latest.raw->>'website', '')),
  directory_source     = 'apify',
  directory_updated_at = now()
from latest
where latest.place_id = vd.place_id
  and vd.phone_e164 is null;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Typeahead venue search matches on name and address. trigram beats prefix
-- matching here because publicans type "long hall" for "The Long Hall".
create extension if not exists pg_trgm;

create index if not exists idx_venue_details_name_trgm
  on public.venue_details using gin (name gin_trgm_ops);

create index if not exists idx_venue_details_address_trgm
  on public.venue_details using gin (formatted_address gin_trgm_ops);

create index if not exists idx_venue_details_country_code
  on public.venue_details (country_code);

-- ── A note for whoever writes the claim flow in Phase 3 ──────────────────────
-- The enrichment data contains at least one Dublin venue listing a +44 mobile.
-- Do not assume country_code and the phone's country agree. Before placing a
-- verification call, check the dialling prefix against country_code and route
-- the mismatches to manual review — an automated call to the wrong country is
-- both a cost and a credibility problem.
