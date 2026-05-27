-- ═══════════════════════════════════════════════════════════════════════════
-- Venue Report Homepage Stats — Required Supabase Setup
-- ───────────────────────────────────────────────────────────────────────────
-- Run this once in the Supabase SQL Editor after venue-insights-setup.sql.
--
-- Returns four aggregates for the venue report homepage dashboard:
--   top_venues          — top 10 venues by card opens in the last 24 hours
--   top_venues_all_time — top 10 venues by card opens across all time
--   new_venues          — count of venues added in the last 24h / 7d / 28d
--   global_actions      — total action clicks (directions/website/uber) last 24h
--
-- Uses SECURITY DEFINER so the anon key can read aggregated event data
-- without direct access to raw event rows.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_homepage_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_24h TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
  v_7d  TIMESTAMPTZ := NOW() - INTERVAL '7 days';
  v_28d TIMESTAMPTZ := NOW() - INTERVAL '28 days';
BEGIN
  RETURN jsonb_build_object(

    -- Top 10 venues by card opens in the last 24 hours (global, all venues)
    'top_venues', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'place_id',   v.place_id,
            'name',       v.name,
            'card_opens', v.card_opens,
            'directions', v.directions,
            'uber',       v.uber
          ) ORDER BY v.card_opens DESC
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          vd.place_id,
          vd.name,
          COUNT(CASE WHEN e.event_type = 'venue_card_opened' THEN 1 END)::int                                                    AS card_opens,
          COUNT(CASE WHEN e.event_type = 'venue_action_clicked' AND e.metadata->>'action' = 'directions' THEN 1 END)::int       AS directions,
          COUNT(CASE WHEN e.event_type = 'venue_action_clicked' AND e.metadata->>'action' = 'uber'       THEN 1 END)::int       AS uber
        FROM events e
        JOIN venue_details vd ON vd.place_id = e.metadata->>'venue_id'
        WHERE e.created_at >= v_24h
          AND e.event_type IN ('venue_card_opened', 'venue_action_clicked')
        GROUP BY vd.place_id, vd.name
        HAVING COUNT(CASE WHEN e.event_type = 'venue_card_opened' THEN 1 END) > 0
        ORDER BY card_opens DESC
        LIMIT 10
      ) v
    ),

    -- Top 10 venues by card opens across all time (no time filter)
    'top_venues_all_time', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'place_id',   v.place_id,
            'name',       v.name,
            'card_opens', v.card_opens,
            'directions', v.directions,
            'uber',       v.uber
          ) ORDER BY v.card_opens DESC
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          vd.place_id,
          vd.name,
          COUNT(CASE WHEN e.event_type = 'venue_card_opened' THEN 1 END)::int                                                    AS card_opens,
          COUNT(CASE WHEN e.event_type = 'venue_action_clicked' AND e.metadata->>'action' = 'directions' THEN 1 END)::int       AS directions,
          COUNT(CASE WHEN e.event_type = 'venue_action_clicked' AND e.metadata->>'action' = 'uber'       THEN 1 END)::int       AS uber
        FROM events e
        JOIN venue_details vd ON vd.place_id = e.metadata->>'venue_id'
        WHERE e.event_type IN ('venue_card_opened', 'venue_action_clicked')
        GROUP BY vd.place_id, vd.name
        HAVING COUNT(CASE WHEN e.event_type = 'venue_card_opened' THEN 1 END) > 0
        ORDER BY card_opens DESC
        LIMIT 10
      ) v
    ),

    -- Count of new venues added to venue_details in each period, plus total
    'new_venues', jsonb_build_object(
      'last_24h', (SELECT COUNT(*)::int FROM venue_details WHERE fetched_at >= v_24h),
      'last_7d',  (SELECT COUNT(*)::int FROM venue_details WHERE fetched_at >= v_7d),
      'last_28d', (SELECT COUNT(*)::int FROM venue_details WHERE fetched_at >= v_28d),
      'total',    (SELECT COUNT(*)::int FROM venue_details)
    ),

    -- Global action breakdown across all venues in the last 24 hours
    'global_actions', jsonb_build_object(
      'directions', (
        SELECT COUNT(*)::int FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'action' = 'directions'
          AND created_at >= v_24h
      ),
      'website', (
        SELECT COUNT(*)::int FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'action' = 'website'
          AND created_at >= v_24h
      ),
      'uber', (
        SELECT COUNT(*)::int FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'action' = 'uber'
          AND created_at >= v_24h
      )
    )

  );
END;
$$;

-- Allow the anon (public) role to call this function
GRANT EXECUTE ON FUNCTION get_homepage_stats() TO anon;
