-- Supabase table setup for Live Pub Crawl Sessions
-- Run this in the Supabase SQL Editor

-- Sessions table
create table if not exists crawl_sessions (
  id uuid default gen_random_uuid() primary key,
  code text not null unique,
  route jsonb not null,
  created_at timestamptz default now(),
  last_activity_at timestamptz default now()
);

-- Index for code lookups
create index if not exists idx_crawl_sessions_code on crawl_sessions (code);

-- Participants table
create table if not exists crawl_participants (
  id uuid default gen_random_uuid() primary key,
  session_id uuid not null references crawl_sessions(id) on delete cascade,
  display_name text not null,
  lat double precision,
  lng double precision,
  last_seen_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists idx_crawl_participants_session on crawl_participants (session_id);

-- Enable realtime on participants table
alter publication supabase_realtime add table crawl_participants;

-- RLS policies (no auth required — anon access)
alter table crawl_sessions enable row level security;
alter table crawl_participants enable row level security;

create policy "Anyone can create sessions" on crawl_sessions for insert with check (true);
create policy "Anyone can read sessions" on crawl_sessions for select using (true);
create policy "Anyone can update session activity" on crawl_sessions for update using (true);

create policy "Anyone can add participants" on crawl_participants for insert with check (true);
create policy "Anyone can read participants" on crawl_participants for select using (true);
create policy "Anyone can update their location" on crawl_participants for update using (true);
create policy "Anyone can remove participants" on crawl_participants for delete using (true);

-- Auto-expire sessions after 8 hours of inactivity (using pg_cron if available)
-- Otherwise, stale sessions are filtered client-side

-- ── Venue Details Cache ───────────────────────────────────────────────────────
-- Caches Google Places API detail responses (hours, photos) for 48 hours.
-- Shared across all users, reducing Places API costs significantly.

create table if not exists venue_details (
  place_id text primary key,
  name text,
  weekday_hours jsonb,        -- full 7-element weekday_text array (Mon–Sun)
  periods jsonb,              -- open/close periods for real-time open status
  utc_offset_minutes integer,
  photos jsonb,               -- serialized photo references (name / photo_reference)
  fetched_at timestamptz default now()
);

create index if not exists idx_venue_details_fetched_at on venue_details (fetched_at);

alter table venue_details enable row level security;

create policy "Anyone can read venue details" on venue_details for select using (true);
create policy "Anyone can insert venue details" on venue_details for insert with check (true);
create policy "Anyone can update venue details" on venue_details for update using (true);

-- ── Analytics: Sessions ───────────────────────────────────────────────────────
-- One row per user visit. Session ID is generated client-side (UUID) and passed
-- with every subsequent event. Tracked server-side without relying on cookies.

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_agent text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  cookie_consent boolean
);

-- ── Analytics: Events ─────────────────────────────────────────────────────────
-- One row per user action. Linked to a session and optionally to a venue.
--
-- Supported event_type values:
--   venue_view         { place_id, position_in_results }
--   search             { query, results_count }
--   filter_applied     { filter_name, filter_value }
--   route_generated    { stop_count, suburbs }
--   directions_tap     { place_id }
--   group_session_created { participant_count }
--   crowdsource_submitted { place_id, attribute }
--   external_link_tap  { place_id, link_type }

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  place_id text references venue_details(place_id) on delete set null,
  event_type text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_session_id on events(session_id);
create index if not exists idx_events_place_id on events(place_id);
create index if not exists idx_events_event_type on events(event_type);
create index if not exists idx_events_created_at on events(created_at);

-- RLS: insert-only for anon, full access for service role (Looker Studio / admin)
alter table sessions enable row level security;
alter table events enable row level security;

create policy "Allow anon insert" on sessions for insert to anon with check (true);
create policy "Allow anon insert" on events for insert to anon with check (true);

create policy "Service role full access" on sessions for all to service_role using (true);
create policy "Service role full access" on events for all to service_role using (true);

-- ── Analytics: Places API Calls ───────────────────────────────────────────────
-- One row per Google Places API call. Used to monitor costs by billing tier.
-- session_id is a loose reference (no FK) so inserts succeed even if the
-- matching session row hasn't landed yet.

create table if not exists places_api_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid,
  call_type text not null,
  billing_tier text not null,
  place_id text,
  result_count integer,
  session_code text,
  created_at timestamptz not null default now()
);

create index if not exists idx_places_api_calls_session_id on places_api_calls(session_id);
create index if not exists idx_places_api_calls_created_at on places_api_calls(created_at);
create index if not exists idx_places_api_calls_call_type on places_api_calls(call_type);

alter table places_api_calls enable row level security;

create policy "Allow anon insert" on places_api_calls for insert to anon with check (true);
create policy "Service role full access" on places_api_calls for all to service_role using (true);

-- ── Fix: Remove events.place_id FK constraint ─────────────────────────────────
-- The events table has a FK on place_id → venue_details(place_id). This causes
-- silent insert failures for events where the venue hasn't been detail-fetched
-- yet. Run this ALTER if events are not recording (check with service role):
--
--   ALTER TABLE events DROP CONSTRAINT IF EXISTS events_place_id_fkey;
--
-- After dropping, place_id becomes a free-text field (no referential check).
