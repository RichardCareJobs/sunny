-- ═══════════════════════════════════════════════════════════════════════════
-- 20260831120100_events_place_id_backfill
--
-- Populates events.place_id, which has never been written to.
--
-- WHY
--   events has a place_id column with a foreign key and an index, and 0 of
--   78,376 venue_view rows have ever set it. The venue identifier is written
--   into metadata->>'venue_id' instead. So every reporting query in Phase 7
--   would have to run an unindexed JSONB extraction across the whole table.
--
--   The table is at ~93,000 rows today. This is a minute of work now and a
--   maintenance window later.
--
-- ORDER OF OPERATIONS — read before applying
--   This migration backfills history. It does NOT stop new rows arriving with
--   a null place_id. The consumer app's analytics.js has to write the column
--   too, and that is a separate one-line change in the consumer app that
--   should land FIRST, so there is no gap between the backfill finishing and
--   correct rows arriving.
--
-- SAFETY
--   Only fills nulls; never overwrites. Rows whose venue_id has no matching
--   venue_details row are left null on purpose — 87% of venues seen in events
--   are not in venue_details, and the foreign key would reject them. Reporting
--   must therefore still tolerate a null place_id, and the rollup job in Phase
--   7 keys on the venue the operator actually claimed, which by definition
--   does have a row.
-- ═══════════════════════════════════════════════════════════════════════════

update public.events e
set place_id = e.metadata->>'venue_id'
where e.place_id is null
  and e.metadata ? 'venue_id'
  and exists (
    select 1 from public.venue_details vd
    where vd.place_id = e.metadata->>'venue_id'
  );

-- Reporting always filters by venue and date together, never by venue alone.
create index if not exists idx_events_place_id_created_at
  on public.events (place_id, created_at desc)
  where place_id is not null;

-- Until analytics.js writes the column, this tells you how much is still
-- arriving unattributed. Expect it to fall to zero once the consumer-app
-- change ships; if it does not, the consumer change did not take.
comment on index public.idx_events_place_id_created_at is
  'Phase 7 reporting. Check attribution coverage with: select count(*) filter '
  '(where place_id is null) from events where created_at > now() - interval ''1 day'';';
