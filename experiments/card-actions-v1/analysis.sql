-- Sunny · experiment card_actions_v1 · analysis queries (Supabase / Postgres)
-- GO-LIVE (UTC): <<FILL IN AT DEPLOY, e.g. 2026-12-01 00:00:00+00>>
-- Replace the timestamp in the `params` CTE of each query before running.
-- Unit of analysis = session (events.session_id). Internal and forced traffic excluded.

------------------------------------------------------------------------------------------
-- 1. PRIMARY: share of card-opening sessions that tapped any action, per variant, + z-test
------------------------------------------------------------------------------------------
with params as (select timestamptz '2026-12-01 00:00:00+00' as start_at, now() as end_at),
exp as (
  select e.*
  from events e, params p
  where e.created_at >= p.start_at and e.created_at < p.end_at
    and e.metadata->>'exp_id' = 'card_actions_v1'
    and coalesce((e.metadata->>'internal')::boolean, false) = false
    and coalesce((e.metadata->>'exp_forced')::boolean, false) = false
),
opened as (
  select session_id, min(metadata->>'exp_variant') as variant   -- one variant per session
  from exp where event_type = 'venue_card_opened'
  group by session_id
  having count(distinct metadata->>'exp_variant') = 1             -- drop the rare mixed session
),
acted as (select distinct session_id from exp where event_type = 'venue_action_clicked'),
per_variant as (
  select o.variant,
         count(*) as card_sessions,
         count(a.session_id) as action_sessions,
         count(a.session_id)::numeric / nullif(count(*), 0) as rate
  from opened o left join acted a using (session_id)
  group by o.variant
),
z as (
  select r.rate as p_rows, b.rate as p_button, r.card_sessions as n_rows, b.card_sessions as n_button,
         (r.action_sessions + b.action_sessions)::numeric / nullif(r.card_sessions + b.card_sessions, 0) as p_pool
  from per_variant r, per_variant b
  where r.variant = 'rows' and b.variant = 'button'
)
select pv.*,
       round(100 * pv.rate, 2) as rate_pct,
       (select round(((p_button - p_rows) / nullif(sqrt(p_pool * (1 - p_pool) * (1.0 / n_rows + 1.0 / n_button)), 0))::numeric, 2) from z)
         as z_button_minus_rows,   -- |z| >= 1.96 ≈ significant at 95%
       (select least(n_rows, n_button) >= 400 from z) as min_sample_reached
from per_variant pv
order by pv.variant;

------------------------------------------------------------------------------------------
-- 2. SECONDARY: taps per card open, by variant × close-by/further-away × action
------------------------------------------------------------------------------------------
with params as (select timestamptz '2026-12-01 00:00:00+00' as start_at, now() as end_at),
exp as (
  select e.* from events e, params p
  where e.created_at >= p.start_at and e.created_at < p.end_at
    and e.metadata->>'exp_id' = 'card_actions_v1'
    and coalesce((e.metadata->>'internal')::boolean, false) = false
    and coalesce((e.metadata->>'exp_forced')::boolean, false) = false
)
select metadata->>'exp_variant' as variant,
       case when (metadata->>'near')::boolean then 'close by' else 'further away' end as mode,
       count(*) filter (where event_type = 'venue_card_opened') as card_opens,
       count(*) filter (where event_type = 'venue_action_clicked' and metadata->>'action' = 'directions') as directions_taps,
       count(*) filter (where event_type = 'venue_action_clicked' and metadata->>'action' = 'uber') as uber_taps,
       round(100.0 * count(*) filter (where event_type = 'venue_action_clicked')
             / nullif(count(*) filter (where event_type = 'venue_card_opened'), 0), 2) as taps_per_100_opens,
       count(*) filter (where event_type = 'trip_line_tapped') as trip_line_taps,
       round(100.0 * count(*) filter (where event_type = 'trip_line_tapped')
             / nullif(count(*) filter (where event_type = 'venue_card_opened'), 0), 2) as trip_taps_per_100_opens
from exp
group by 1, 2
order by 1, 2;

------------------------------------------------------------------------------------------
-- 3. SECONDARY: which slot gets tapped (is row 2 / the text link used?)
------------------------------------------------------------------------------------------
with params as (select timestamptz '2026-12-01 00:00:00+00' as start_at, now() as end_at)
select e.metadata->>'exp_variant' as variant,
       e.metadata->>'slot' as slot,
       e.metadata->>'action' as action,
       count(*) as taps
from events e, params p
where e.created_at >= p.start_at and e.created_at < p.end_at
  and e.event_type = 'venue_action_clicked'
  and e.metadata->>'exp_id' = 'card_actions_v1'
  and coalesce((e.metadata->>'internal')::boolean, false) = false
  and coalesce((e.metadata->>'exp_forced')::boolean, false) = false
group by 1, 2, 3
order by 1, 4 desc;

------------------------------------------------------------------------------------------
-- 4. HEALTH CHECK (run daily in week 1): split balance, tagging coverage, internal volume
------------------------------------------------------------------------------------------
with params as (select timestamptz '2026-12-01 00:00:00+00' as start_at)
select date_trunc('day', e.created_at at time zone 'Australia/Sydney') as day_syd,
       count(*) filter (where e.metadata->>'exp_variant' = 'rows')   as opens_rows,
       count(*) filter (where e.metadata->>'exp_variant' = 'button') as opens_button,
       count(*) filter (where e.metadata->>'exp_id' is null)         as opens_untagged,   -- should be ~0
       count(*) filter (where (e.metadata->>'internal')::boolean)    as opens_internal,
       count(*) filter (where (e.metadata->>'exp_forced')::boolean)  as opens_forced
from events e, params p
where e.created_at >= p.start_at and e.event_type = 'venue_card_opened'
group by 1
order by 1;
