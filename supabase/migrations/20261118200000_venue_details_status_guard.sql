-- Guard venue_details.qualification_status against the public key.
-- Additive only: one trigger function and one trigger; no column, policy or grant changes.
--
-- Why: RLS on venue_details lets anyone insert and update ("Anyone can insert /
-- update venue details", both `true`). So anyone holding the publishable key could
-- un-reject a venue Sunny excluded (e.g. the rejected_not_eligible imports and data
-- fixes), or reject a good venue to hide it from search (SearchCore.isListedVenueRow
-- hides every rejected_* row).
--
-- Rule, for the anon and authenticated roles only (the public app via PostgREST):
--   * a qualification_status starting with 'rejected_' can't be changed, and
--   * no row can be given a 'rejected_' status (insert, update or upsert).
-- Everything else is unchanged: hours/photos cache writes, confirmed/unknown
-- qualification writes, and the view counter all keep working.
--
-- Exempt: every other role, i.e. service_role (imports, Edge Functions), postgres
-- (SQL editor, MCP, data fixes in supabase/data-fixes/) and SECURITY DEFINER
-- functions owned by postgres (such as increment_venue_view_count). An editorial
-- status change is therefore a plain UPDATE run from the SQL editor or with the
-- service role.
--
-- The client already follows the same rule (js/qualification-core.js): it never
-- refreshes a rejected_ row and stores a negative Places result as
-- 'unknown_after_enrichment' plus the facts (outdoor_seating / serves_*).
--
-- Tests: supabase/tests/venue_details_status_guard.test.sql (always rolls back).

create or replace function public.guard_venue_qualification_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.qualification_status like 'rejected\_%'
     and new.qualification_status is distinct from old.qualification_status then
    raise exception 'venue_details: qualification_status % is editorial and cannot be changed with the public key (place_id %)',
      old.qualification_status, old.place_id
      using errcode = '42501';
  end if;

  if new.qualification_status like 'rejected\_%'
     and (tg_op = 'INSERT' or new.qualification_status is distinct from old.qualification_status) then
    raise exception 'venue_details: qualification_status % can only be set editorially, not with the public key (place_id %)',
      new.qualification_status, new.place_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.guard_venue_qualification_status() is
  'Blocks anon/authenticated from changing or setting a rejected_* qualification_status. See migration 20261118200000.';

drop trigger if exists venue_details_status_guard on public.venue_details;
create trigger venue_details_status_guard
  before insert or update on public.venue_details
  for each row execute function public.guard_venue_qualification_status();
