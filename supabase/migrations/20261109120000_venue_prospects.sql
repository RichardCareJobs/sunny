-- Search leads: venues people searched for that Sunny doesn't list (yet).
-- Additive only: one new table and two functions; no existing table is altered.
--
-- Only place_id and the venue name are stored (no address or coordinates).
-- google_checked_at / google_outdoor_seating remember the result of a paid
-- Place Details (Enterprise + Atmosphere) check so the same venue is never
-- checked twice within 90 days, whoever searches for it.
--
-- RLS is on with no policies: the table is readable/writable by service_role
-- only. The public app goes through the two security-definer functions below,
-- following the increment_venue_view_count precedent.

create table if not exists public.venue_prospects (
  place_id               text primary key,
  name                   text not null,
  source                 text not null default 'search',
  reason                 text not null default 'outdoor_unverified'
                           check (reason in ('outdoor_unverified','type_not_eligible','not_displayed')),
  search_count           integer not null default 1,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  google_checked_at      timestamptz,          -- when Google was last asked about outdoor seating
  google_outdoor_seating boolean               -- null = Google doesn't know (or never asked)
);

alter table public.venue_prospects enable row level security;

create index if not exists idx_venue_prospects_last_seen_at on public.venue_prospects (last_seen_at desc);

-- place_id must match ^[A-Za-z0-9_-]{10,300}$ in both functions. It is written as a
-- character-class check plus a length check because Postgres caps regex repeat counts at 255.

-- Insert a lead or bump its count. p_google_checked = true also stores the
-- result of a Google outdoor-seating check made just now.
create or replace function public.record_venue_prospect(
  p_place_id               text,
  p_name                   text,
  p_source                 text default 'search',
  p_reason                 text default 'outdoor_unverified',
  p_google_checked         boolean default false,
  p_google_outdoor_seating boolean default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_place_id is null or p_place_id !~ '^[A-Za-z0-9_-]+$'
     or length(p_place_id) not between 10 and 300 then
    return;
  end if;
  if p_name is null or btrim(p_name) = '' then
    return;
  end if;
  if p_reason is null or p_reason not in ('outdoor_unverified','type_not_eligible','not_displayed') then
    p_reason := 'outdoor_unverified';
  end if;

  insert into public.venue_prospects as vp
    (place_id, name, source, reason, google_checked_at, google_outdoor_seating)
  values (
    p_place_id,
    left(btrim(p_name), 200),
    left(coalesce(nullif(btrim(p_source), ''), 'search'), 40),
    p_reason,
    case when p_google_checked then now() end,
    case when p_google_checked then p_google_outdoor_seating end
  )
  on conflict (place_id) do update set
    search_count           = vp.search_count + 1,
    last_seen_at           = now(),
    name                   = excluded.name,
    reason                 = excluded.reason,
    google_checked_at      = case when p_google_checked then now() else vp.google_checked_at end,
    google_outdoor_seating = case when p_google_checked then p_google_outdoor_seating else vp.google_outdoor_seating end;
end;
$$;

-- Should the app pay for a Google outdoor-seating check on this venue?
-- false when the venue is already in venue_details, or was checked in the last 90 days.
create or replace function public.should_verify_venue(p_place_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_place_id is not null
    and p_place_id ~ '^[A-Za-z0-9_-]+$'
    and length(p_place_id) between 10 and 300
    and not exists (select 1 from public.venue_details vd where vd.place_id = p_place_id)
    and not exists (
      select 1 from public.venue_prospects vp
      where vp.place_id = p_place_id
        and vp.google_checked_at > now() - interval '90 days'
    );
$$;

revoke all on function public.record_venue_prospect(text, text, text, text, boolean, boolean) from public;
revoke all on function public.should_verify_venue(text) from public;
grant execute on function public.record_venue_prospect(text, text, text, text, boolean, boolean) to anon, authenticated, service_role;
grant execute on function public.should_verify_venue(text) to anon, authenticated, service_role;
