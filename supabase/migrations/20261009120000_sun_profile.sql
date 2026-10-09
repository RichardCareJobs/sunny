-- Live sun/shade estimates (Dublin v1, city-parameterised).
-- Additive only: creates three new tables; does not alter any existing table.
--
-- Licence note: every value in these tables is derived from OpenStreetMap
-- (© OpenStreetMap contributors, ODbL), the 2015 Dublin LiDAR, and Sunny's own
-- enrichment / manual input. No Google coordinates or Google map content are
-- stored here. place_id is the only Google-derived value (permitted to store).
--
-- RLS mirrors the existing enrichment tables:
--   venue_seating, venue_sun_profile -> public SELECT, no write policies
--                                       (writes via service_role only), like venue_attributes
--   sun_pipeline_runs                -> RLS on, no policies (service_role only), like venue_enrichment

-- ── Seating point per venue ──────────────────────────────────────────────────
create table if not exists public.venue_seating (
  place_id            text primary key references public.venue_details(place_id),
  city                text not null,
  seating_lat         double precision not null,
  seating_lng         double precision not null,
  seating_type        text not null default 'unknown'
                        check (seating_type in ('front','rear','rooftop','street','unknown')),
  seating_source      text not null default 'auto'
                        check (seating_source in ('auto','enrichment','manual','venue')),
  seating_confidence  text not null default 'low'
                        check (seating_confidence in ('low','medium','high')),
  seating_height_m    real not null default 0,      -- height of the seating surface above ground (rooftops)
  osm_building_id     text,                          -- e.g. 'way/123456'
  osm_poi_id          text,                          -- e.g. 'node/987654'
  match_method        text,                          -- e.g. 'name_exact', 'name_fuzzy', 'manual'
  match_score         real,
  updated_at          timestamptz not null default now(),
  check (seating_lat between -90 and 90 and seating_lng between -180 and 180)
);

create index if not exists idx_venue_seating_city on public.venue_seating (city);

-- ── Pre-computed horizon profile per venue seating point ─────────────────────
create table if not exists public.venue_sun_profile (
  place_id            text primary key references public.venue_details(place_id),
  city                text not null,
  -- 72 skyline elevation angles, tenths of a degree, azimuth 0°,5°,…,355°
  -- (clockwise from true north). Negative allowed (rooftop looking down).
  horizon             smallint[] not null
                        check (array_length(horizon, 1) = 72 and array_ndims(horizon) = 1),
  data_quality        numeric(4,3) not null check (data_quality between 0 and 1),
  buildings_total     integer not null default 0,
  buildings_lidar     integer not null default 0,
  buildings_osm_height integer not null default 0,
  buildings_levels    integer not null default 0,
  buildings_default   integer not null default 0,
  ray_length_m        real not null default 300,
  eye_height_m        real not null default 1.2,
  osm_extract_date    timestamptz not null,
  lidar_source        text,
  computed_at         timestamptz not null default now(),
  algorithm_version   text not null
);

create index if not exists idx_venue_sun_profile_city on public.venue_sun_profile (city);

-- ── Pipeline run log ─────────────────────────────────────────────────────────
create table if not exists public.sun_pipeline_runs (
  id                  uuid primary key default gen_random_uuid(),
  city                text not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  algorithm_version   text not null,
  osm_extract_date    timestamptz,
  venues_considered   integer,
  venues_matched      integer,
  venues_processed    integer,
  venues_failed       integer,
  avg_data_quality    numeric(4,3),
  lidar_disagreements integer,
  params              jsonb,
  summary             jsonb
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.venue_seating     enable row level security;
alter table public.venue_sun_profile enable row level security;
alter table public.sun_pipeline_runs enable row level security;

create policy "Public can read venue seating"
  on public.venue_seating for select using (true);

create policy "Public can read venue sun profiles"
  on public.venue_sun_profile for select using (true);
