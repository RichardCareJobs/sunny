-- Tests for migration 20261118200000_venue_details_status_guard.sql.
--
-- Replays the exact statement shape of every app.js write to venue_details as the
-- anon role (PostgREST upserts are `insert … on conflict (place_id) do update set`
-- the supplied columns only), plus the cases the guard must block and the roles it
-- must leave alone.
--
-- Always rolls back: the DO block ends by raising, and the script is wrapped in
-- begin/rollback. Output is the exception message:
--   "venue_details guard: all N checks passed"   or   "FAILED: <check>: <detail>"
--
-- The trigger must exist first. To test before applying the migration, run the
-- migration and this file in one transaction (as one query string, or psql -1):
--   begin; <migration sql>; <this file without its begin/rollback>; rollback;
-- Creating the trigger locks venue_details briefly: run on production only off-peak.

begin;

do $test$
declare
  passed int := 0;
  st text;
  -- Synthetic ids, never real Google place ids.
  p_new_cache  constant text := 'TEST_GUARD_new_cache_row';
  p_rejected   constant text := 'TEST_GUARD_rejected_row';
  p_unknown    constant text := 'TEST_GUARD_unknown_row';
  p_new_search constant text := 'TEST_GUARD_new_search_row';
  p_new_reject constant text := 'TEST_GUARD_new_rejected_row';

begin
  -- Seed as the owner (exempt).
  insert into public.venue_details (place_id, name, qualification_status, enrichment_source, view_count)
  values (p_rejected, 'Guard test rejected', 'rejected_not_eligible', 'apify_google_maps', 0),
         (p_unknown,  'Guard test unknown',  'unknown_after_enrichment', 'apify_google_maps', 0);

  ------------------------------------------------------------------ allowed (anon)
  -- 1. saveVenueDetailsToSupabase (app.js, hours/photos cache): new row.
  set local role anon;
  insert into public.venue_details (place_id, name, weekday_hours, periods, utc_offset_minutes, photos, fetched_at)
  values (p_new_cache, 'Guard cache', '[]', '[]', 0, '[]', now())
  on conflict (place_id) do update set name = excluded.name, weekday_hours = excluded.weekday_hours,
    periods = excluded.periods, utc_offset_minutes = excluded.utc_offset_minutes,
    photos = excluded.photos, fetched_at = excluded.fetched_at;
  reset role;
  passed := passed + 1;

  -- 2. saveVenueDetailsToSupabase on an existing rejected row: allowed, status unchanged.
  set local role anon;
  insert into public.venue_details (place_id, name, weekday_hours, periods, utc_offset_minutes, photos, fetched_at)
  values (p_rejected, 'Guard test rejected', '["Mon"]', '[]', 60, '[]', now())
  on conflict (place_id) do update set name = excluded.name, weekday_hours = excluded.weekday_hours,
    periods = excluded.periods, utc_offset_minutes = excluded.utc_offset_minutes,
    photos = excluded.photos, fetched_at = excluded.fetched_at;
  reset role;
  select qualification_status into st from public.venue_details where place_id = p_rejected;
  if st is distinct from 'rejected_not_eligible' then raise exception 'FAILED: 2 cache upsert changed status: %', st; end if;
  passed := passed + 1;

  -- 3. Enricher saveRow via saveVenueQualificationToSupabase: confirmed on an unknown row.
  set local role anon;
  insert into public.venue_details (place_id, qualification_status, outdoor_seating, serves_beer, serves_wine,
    serves_cocktails, last_enriched_at, enrichment_source, candidate_score, candidate_bucket, discovery_source)
  values (p_unknown, 'confirmed', true, true, null, null, now(), 'places_api', 85, 'obvious_fit', 'nearby')
  on conflict (place_id) do update set qualification_status = excluded.qualification_status,
    outdoor_seating = excluded.outdoor_seating, serves_beer = excluded.serves_beer, serves_wine = excluded.serves_wine,
    serves_cocktails = excluded.serves_cocktails, last_enriched_at = excluded.last_enriched_at,
    enrichment_source = excluded.enrichment_source, candidate_score = excluded.candidate_score,
    candidate_bucket = excluded.candidate_bucket, discovery_source = excluded.discovery_source;
  reset role;
  passed := passed + 1;

  -- 4. Enricher saveRow, strict-mode negative result: unknown + outdoor_seating=false.
  set local role anon;
  insert into public.venue_details (place_id, qualification_status, outdoor_seating, serves_beer, serves_wine,
    serves_cocktails, last_enriched_at, enrichment_source, candidate_score, candidate_bucket, discovery_source)
  values (p_unknown, 'unknown_after_enrichment', false, true, null, null, now(), 'places_api', null, null, null)
  on conflict (place_id) do update set qualification_status = excluded.qualification_status,
    outdoor_seating = excluded.outdoor_seating, serves_beer = excluded.serves_beer, serves_wine = excluded.serves_wine,
    serves_cocktails = excluded.serves_cocktails, last_enriched_at = excluded.last_enriched_at,
    enrichment_source = excluded.enrichment_source, candidate_score = excluded.candidate_score,
    candidate_bucket = excluded.candidate_bucket, discovery_source = excluded.discovery_source;
  reset role;
  passed := passed + 1;

  -- 5. Search seeding (selectVenueResult): a new confirmed row.
  set local role anon;
  insert into public.venue_details (place_id, name, fetched_at, qualification_status, outdoor_seating, serves_beer,
    serves_wine, serves_cocktails, last_enriched_at, enrichment_source, discovery_source)
  values (p_new_search, 'Guard search', to_timestamp(0), 'confirmed', true, true, null, null, now(), 'places_api', 'search')
  on conflict (place_id) do update set name = excluded.name, fetched_at = excluded.fetched_at,
    qualification_status = excluded.qualification_status, outdoor_seating = excluded.outdoor_seating,
    serves_beer = excluded.serves_beer, serves_wine = excluded.serves_wine, serves_cocktails = excluded.serves_cocktails,
    last_enriched_at = excluded.last_enriched_at, enrichment_source = excluded.enrichment_source,
    discovery_source = excluded.discovery_source;
  reset role;
  passed := passed + 1;

  -- 6. increment_venue_view_count RPC on a rejected row.
  set local role anon;
  perform public.increment_venue_view_count(p_rejected);
  reset role;
  if (select view_count from public.venue_details where place_id = p_rejected) <> 1 then
    raise exception 'FAILED: 6 view count not incremented';
  end if;
  passed := passed + 1;

  ------------------------------------------------------------------ blocked
  -- Each runs in its own sub-block; the caught error rolls back the sub-block,
  -- including its SET LOCAL ROLE.

  -- 7. anon: confirmed over a rejected row (enricher-shaped upsert).
  begin
    set local role anon;
    insert into public.venue_details (place_id, qualification_status, last_enriched_at, enrichment_source)
    values (p_rejected, 'confirmed', now(), 'places_api')
    on conflict (place_id) do update set qualification_status = excluded.qualification_status,
      last_enriched_at = excluded.last_enriched_at, enrichment_source = excluded.enrichment_source;
    raise exception 'FAILED: 7 anon changed a rejected_ status';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 8. anon: plain update unknown -> rejected_not_eligible.
  begin
    set local role anon;
    update public.venue_details set qualification_status = 'rejected_not_eligible' where place_id = p_new_search;
    raise exception 'FAILED: 8 anon set rejected_not_eligible';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 9. anon: insert a brand-new rejected row.
  begin
    set local role anon;
    insert into public.venue_details (place_id, name, qualification_status) values (p_new_reject, 'x', 'rejected_no_outdoor');
    raise exception 'FAILED: 9 anon inserted a rejected_ row';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 10. anon: upsert rejected_no_alcohol over an existing unknown row (old client shape).
  begin
    set local role anon;
    insert into public.venue_details (place_id, qualification_status) values (p_unknown, 'rejected_no_alcohol')
    on conflict (place_id) do update set qualification_status = excluded.qualification_status;
    raise exception 'FAILED: 10 anon upserted rejected_no_alcohol';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 11. anon: clear a rejected status to null.
  begin
    set local role anon;
    update public.venue_details set qualification_status = null where place_id = p_rejected;
    raise exception 'FAILED: 11 anon cleared a rejected_ status';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 12. authenticated: change a rejected status.
  begin
    set local role authenticated;
    update public.venue_details set qualification_status = 'confirmed' where place_id = p_rejected;
    raise exception 'FAILED: 12 authenticated changed a rejected_ status';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- 13. authenticated: set a rejected status.
  begin
    set local role authenticated;
    update public.venue_details set qualification_status = 'rejected_not_eligible' where place_id = p_new_search;
    raise exception 'FAILED: 13 authenticated set rejected_not_eligible';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  select qualification_status into st from public.venue_details where place_id = p_rejected;
  if st is distinct from 'rejected_not_eligible' then raise exception 'FAILED: rejected row changed to %', st; end if;

  ------------------------------------------------------------------ exempt roles
  -- 14. service_role: unknown -> rejected_not_eligible -> unknown.
  set local role service_role;
  update public.venue_details set qualification_status = 'rejected_not_eligible' where place_id = p_new_search;
  update public.venue_details set qualification_status = 'unknown_after_enrichment' where place_id = p_new_search;
  reset role;
  passed := passed + 1;

  -- 15. owner (SQL editor / data fixes): rejected -> unknown -> rejected.
  update public.venue_details set qualification_status = 'unknown_after_enrichment' where place_id = p_rejected;
  update public.venue_details set qualification_status = 'rejected_not_eligible' where place_id = p_rejected;
  passed := passed + 1;

  raise exception 'venue_details guard: all % checks passed', passed;
end
$test$;

rollback;
