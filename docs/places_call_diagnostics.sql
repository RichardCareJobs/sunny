-- Diagnose *why* Sunny makes Google Places calls, using the diagnostic columns added in
-- supabase/migrations/20261121120000_places_api_calls_diagnostics.sql.
-- Run each query separately in the Supabase SQL editor. All are read-only.
-- Change the interval in each `where` to widen or narrow the window.

-- ── 1. Calls per session, by what triggered them ────────────────────────────────
-- Targets after the Nov 2026 fixes: median ≤ 6 calls/session, p95 ≤ 25.
with per_session as (
  select session_id,
    count(*) as calls,
    count(*) filter (where reason = 'initial') as initial,
    count(*) filter (where reason = 'map_move') as map_move,
    count(*) filter (where reason in ('card_open', 'photo_viewer')) as card,
    count(*) filter (where reason = 'search_box') as search_box,
    count(*) filter (where reason = 'qualification') as qualification,
    count(*) filter (where reason is null) as untagged
  from places_api_calls
  where created_at >= now() - interval '7 days'
  group by session_id
)
select
  count(*) as sessions,
  sum(calls) as calls,
  percentile_cont(0.5) within group (order by calls) as median_calls,
  percentile_cont(0.95) within group (order by calls) as p95_calls,
  max(calls) as max_calls,
  sum(initial) as initial, sum(map_move) as map_move, sum(card) as card_and_photos,
  sum(search_box) as search_box, sum(qualification) as qualification, sum(untagged) as untagged
from per_session;

-- ── 2. Map-search passes: what each one is worth ────────────────────────────────
-- unique_new = venues this pass found that no other pass in the same search found.
-- A pass with a low unique share is a candidate to drop or run less often (plan step 2c).
select
  pass_label,
  count(*) as calls,
  round(avg(result_count), 1) as avg_results,
  round(100.0 * count(*) filter (where result_count = 0) / nullif(count(*), 0), 1) as pct_zero_results,
  sum(unique_new) as unique_venues_found,
  round(avg(unique_new), 2) as avg_unique_per_call,
  round(100.0 * sum(unique_new) / nullif(sum(sum(unique_new)) over (), 0), 1) as pct_of_all_unique
from places_api_calls
where created_at >= now() - interval '7 days'
  and pass_label is not null
group by pass_label
order by calls desc;

-- ── 3. Paid-for results that arrived after the user moved on ────────────────────
-- These are still cached client-side now, but a high share means searches start too eagerly.
select
  date_trunc('day', created_at)::date as day,
  count(*) filter (where pass_label is not null) as map_search_calls,
  count(*) filter (where discarded) as discarded,
  round(100.0 * count(*) filter (where discarded) / nullif(count(*) filter (where pass_label is not null), 0), 1) as pct_discarded
from places_api_calls
where created_at >= now() - interval '14 days'
group by 1
order by 1 desc;

-- ── 4. Zoom levels map searches happen at ───────────────────────────────────────
select zoom, count(*) as calls, count(distinct session_id) as sessions
from places_api_calls
where created_at >= now() - interval '7 days'
  and pass_label is not null
group by zoom
order by zoom;

-- ── 5. Popular search areas (shared-cache potential for plan step 3c) ───────────
-- Areas many different sessions pay for are what a shared server-side cache would save.
select
  split_part(tile_key, ':', 1) || ',' || split_part(tile_key, ':', 2) as cell,
  count(distinct session_id) as sessions,
  count(*) as calls,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from places_api_calls
where created_at >= now() - interval '7 days'
  and tile_key is not null
group by 1
order by calls desc
limit 25;

-- ── 6. Photo loads vs card opens ────────────────────────────────────────────────
-- Expect roughly one photo load per card open (hero only), plus viewer swipes.
with photos as (
  select date_trunc('day', created_at)::date as day,
    count(*) filter (where reason = 'card_open') as hero_loads,
    count(*) filter (where reason = 'photo_viewer') as viewer_loads
  from places_api_calls
  where call_type = 'photo' and created_at >= now() - interval '14 days'
  group by 1
),
opens as (
  select date_trunc('day', created_at)::date as day, count(*) as card_opens
  from events
  where event_type = 'venue_card_opened' and created_at >= now() - interval '14 days'
  group by 1
)
select o.day, o.card_opens, coalesce(p.hero_loads, 0) as hero_loads, coalesce(p.viewer_loads, 0) as viewer_loads,
  round((coalesce(p.hero_loads, 0) + coalesce(p.viewer_loads, 0))::numeric / nullif(o.card_opens, 0), 2) as photos_per_open
from opens o
left join photos p using (day)
order by o.day desc;

-- ── 7. Heaviest sessions (possible bots or loops) ───────────────────────────────
-- Joins the self-reported user agent; a real visitor normally also has interaction events.
select
  c.session_id,
  count(*) as calls,
  min(c.created_at) as first_call,
  round(extract(epoch from max(c.created_at) - min(c.created_at)) / 60.0, 1) as minutes,
  s.user_agent,
  s.referrer,
  (select count(*) from events e where e.session_id = c.session_id) as events
from places_api_calls c
left join sessions s on s.id = c.session_id
where c.created_at >= now() - interval '7 days'
group by c.session_id, s.user_agent, s.referrer
order by calls desc
limit 20;
