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
