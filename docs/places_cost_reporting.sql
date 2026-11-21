-- Google Places API (New) cost estimate from places_api_calls.
--
-- Maps each logged (call_type, billing_tier) to the Google SKU it bills under, applies the
-- monthly free allowance per SKU, and estimates cost in USD and AUD.
--
-- Prices are Google Maps Platform list prices per 1,000 calls (USD, first volume tier) with
-- the monthly free calls per SKU. Adjust the `sku_price` CTE if Google changes them.
-- `fx` converts to the AUD your invoice shows (Nov 2026 invoice works out to ~1.42).
--
-- Logged volumes reconcile with the invoice only for calls made after the
-- 20261121 logging fix (see app.js logPlacesApiCall); earlier months under-count the
-- first map search of each visit and every photo load.

-- ── 1. Month to date, per SKU ───────────────────────────────────────────────────
with params as (
  select date_trunc('month', now()) as month_start, 1.42::numeric as fx
),
sku_price(sku, usd_per_1000, free_per_month) as (
  values
    ('Text Search Pro',                       32.00, 5000),
    ('Nearby Search Pro',                     32.00, 5000),
    ('Place Details Essentials',               5.00, 10000),
    ('Place Details Pro',                     17.00, 5000),
    ('Place Details Enterprise',              20.00, 1000),
    ('Place Details Enterprise + Atmosphere', 25.00, 1000),
    ('Place Details Photos',                   7.00, 1000),
    ('Autocomplete Requests',                  2.83, 10000)
),
calls as (
  select
    case
      when call_type = 'text_search' then 'Text Search Pro'
      when call_type = 'nearby_search' then 'Nearby Search Pro'
      when call_type = 'photo' or billing_tier = 'photo' then 'Place Details Photos'
      when billing_tier = 'autocomplete_request' then 'Autocomplete Requests'
      when billing_tier = 'enterprise_plus_atmosphere' then 'Place Details Enterprise + Atmosphere'
      when billing_tier = 'enterprise' then 'Place Details Enterprise'
      when billing_tier = 'essentials' then 'Place Details Essentials'
      -- 'basic' was a mislabel for displayName requests, which bill as Pro
      when billing_tier in ('basic', 'pro') then 'Place Details Pro'
      else 'Unmapped: ' || coalesce(call_type, '?') || '/' || coalesce(billing_tier, '?')
    end as sku
  from places_api_calls, params
  where created_at >= params.month_start
)
select
  c.sku,
  count(*) as calls,
  coalesce(p.free_per_month, 0) as free_per_month,
  greatest(count(*) - coalesce(p.free_per_month, 0), 0) as billable_calls,
  round(greatest(count(*) - coalesce(p.free_per_month, 0), 0) * coalesce(p.usd_per_1000, 0) / 1000, 2) as est_usd,
  round(greatest(count(*) - coalesce(p.free_per_month, 0), 0) * coalesce(p.usd_per_1000, 0) / 1000 * (select fx from params), 2) as est_aud
from calls c
left join sku_price p using (sku)
group by c.sku, p.free_per_month, p.usd_per_1000
order by est_usd desc, calls desc;

-- ── 2. Daily volume and list-price cost (before free allowances) ───────────────
-- Useful for spotting spikes; the free allowance is monthly so it isn't applied per day.
with sku_price(sku, usd_per_call) as (
  values
    ('text_search', 0.032), ('nearby_search', 0.032), ('photo', 0.007),
    ('enterprise', 0.020), ('enterprise_plus_atmosphere', 0.025),
    ('essentials', 0.005), ('pro', 0.017), ('basic', 0.017),
    ('autocomplete_request', 0.00283)
),
base as (
  select
    date_trunc('day', created_at at time zone 'UTC')::date as day,
    session_id,
    call_type,
    case when call_type in ('text_search', 'nearby_search', 'photo') then call_type
         else billing_tier end as price_key
  from places_api_calls
  where created_at >= now() - interval '60 days'
)
select
  day,
  count(*) as total_calls,
  count(*) filter (where call_type = 'text_search') as text_search,
  count(*) filter (where call_type = 'nearby_search') as nearby_search,
  count(*) filter (where call_type = 'place_details') as place_details,
  count(*) filter (where call_type = 'photo') as photos,
  count(distinct session_id) as sessions,
  round(count(*)::numeric / nullif(count(distinct session_id), 0), 1) as calls_per_session,
  round(sum(coalesce(p.usd_per_call, 0)), 2) as list_price_usd,
  round(sum(coalesce(p.usd_per_call, 0)) / nullif(count(distinct session_id), 0), 4) as list_usd_per_session,
  round(sum(sum(coalesce(p.usd_per_call, 0))) over (order by day), 2) as cumulative_list_usd
from base b
left join sku_price p on p.sku = b.price_key
group by day
order by day desc;
