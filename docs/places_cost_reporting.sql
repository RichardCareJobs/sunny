-- Better Google Places API cost visibility for Supabase
-- Assumes all rows in `places_api_calls` are billable attempts.
-- Prices are per-call estimates and can be adjusted in the `pricing` CTE.

with pricing as (
  select * from (values
    ('basic'::text, 0.032::numeric),
    ('atmosphere'::text, 0.170::numeric)
  ) as p(billing_tier, price_usd)
),
base as (
  select
    date_trunc('day', created_at at time zone 'UTC')::date as day,
    coalesce(nullif(trim(lower(billing_tier)), ''), 'unknown') as billing_tier,
    coalesce(nullif(trim(lower(call_type)), ''), 'unknown') as call_type,
    session_id,
    result_count,
    created_at
  from places_api_calls
),
costed as (
  select
    b.day,
    b.billing_tier,
    b.call_type,
    b.session_id,
    b.result_count,
    coalesce(p.price_usd, 0::numeric) as unit_price_usd,
    case when p.billing_tier is null then false else true end as is_priced
  from base b
  left join pricing p using (billing_tier)
),
daily as (
  select
    day,
    count(*) as total_calls,
    count(*) filter (where billing_tier = 'basic') as basic_calls,
    count(*) filter (where billing_tier = 'atmosphere') as atmosphere_calls,
    count(*) filter (where billing_tier = 'unknown' or not is_priced) as unpriced_calls,
    count(distinct session_id) as distinct_sessions,
    round(sum(unit_price_usd), 2) as est_total_cost_usd,
    round(sum(case when billing_tier = 'basic' then unit_price_usd else 0 end), 2) as basic_cost_usd,
    round(sum(case when billing_tier = 'atmosphere' then unit_price_usd else 0 end), 2) as atmosphere_cost_usd,
    round(avg(unit_price_usd), 4) as est_cost_per_call_usd,
    round(sum(unit_price_usd) / nullif(count(distinct session_id), 0), 4) as est_cost_per_session_usd,
    round(avg(result_count::numeric) filter (where result_count is not null), 2) as avg_results_per_call
  from costed
  group by day
)
select
  day,
  total_calls,
  basic_calls,
  atmosphere_calls,
  unpriced_calls,
  distinct_sessions,
  basic_cost_usd,
  atmosphere_cost_usd,
  est_total_cost_usd,
  est_cost_per_call_usd,
  est_cost_per_session_usd,
  avg_results_per_call,
  round(avg(est_total_cost_usd) over (
    order by day rows between 6 preceding and current row
  ), 2) as cost_7d_moving_avg_usd,
  round(sum(est_total_cost_usd) over (order by day), 2) as cumulative_cost_usd
from daily
order by day desc;

-- Optional: top cost-driving call types for a selected date range.
-- Replace :from_date and :to_date with real dates in Supabase SQL editor.
--
-- with pricing as (
--   select * from (values
--     ('basic'::text, 0.032::numeric),
--     ('atmosphere'::text, 0.170::numeric)
--   ) as p(billing_tier, price_usd)
-- )
-- select
--   coalesce(nullif(trim(lower(call_type)), ''), 'unknown') as call_type,
--   count(*) as calls,
--   round(sum(coalesce(p.price_usd, 0::numeric)), 2) as est_cost_usd
-- from places_api_calls c
-- left join pricing p on lower(c.billing_tier) = p.billing_tier
-- where c.created_at >= :from_date::timestamptz
--   and c.created_at < (:to_date::date + 1)::timestamptz
-- group by 1
-- order by est_cost_usd desc, calls desc;
