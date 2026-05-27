-- ═══════════════════════════════════════════════════════════════════════════
-- Venue Insights Report — Required Supabase Setup
-- ───────────────────────────────────────────────────────────────────────────
-- Run this once in the Supabase SQL Editor (or via supabase db push).
--
-- Why: the `events` table only allows anon INSERT (not SELECT) for privacy.
-- This function uses SECURITY DEFINER to aggregate data server-side, then
-- exposes only the aggregated totals to the anon (public) role — so the
-- venue-report page never has direct access to raw event rows.
--
-- Event types used:
--   venue_view          — venue marker appeared in the visible map area
--   venue_card_opened   — user tapped the venue to open its detail card
--   venue_action_clicked — user tapped Directions / Website / Uber
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_venue_insights(p_venue_id TEXT, p_days INT DEFAULT 28)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cut  TIMESTAMPTZ := NOW() - (p_days       || ' days')::INTERVAL;
  v_prev TIMESTAMPTZ := NOW() - (p_days * 2   || ' days')::INTERVAL;
BEGIN
  RETURN jsonb_build_object(

    -- Current period counts
    'current', jsonb_build_object(
      'venue_views', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_view'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_cut
      ),
      'card_opens', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_card_opened'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_cut
      ),
      'directions', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'directions'
          AND created_at >= v_cut
      ),
      'website', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'website'
          AND created_at >= v_cut
      ),
      'uber', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'uber'
          AND created_at >= v_cut
      )
    ),

    -- Previous period counts (for trend ↑↓ indicators)
    'previous', jsonb_build_object(
      'venue_views', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_view'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_prev AND created_at < v_cut
      ),
      'card_opens', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_card_opened'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_prev AND created_at < v_cut
      ),
      'directions', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'directions'
          AND created_at >= v_prev AND created_at < v_cut
      ),
      'website', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'website'
          AND created_at >= v_prev AND created_at < v_cut
      ),
      'uber', (
        SELECT COUNT(*) FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND metadata->>'action'   = 'uber'
          AND created_at >= v_prev AND created_at < v_cut
      )
    ),

    -- Daily venue-view counts for the funnel chart
    'daily_views', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('d', day, 'n', cnt) ORDER BY day),
        '[]'::jsonb
      )
      FROM (
        SELECT created_at::DATE AS day, COUNT(*) AS cnt
        FROM events
        WHERE event_type = 'venue_view'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_cut
        GROUP BY day
      ) x
    ),

    -- Daily card-open counts for bar/line charts
    'daily_opens', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('d', day, 'n', cnt) ORDER BY day),
        '[]'::jsonb
      )
      FROM (
        SELECT created_at::DATE AS day, COUNT(*) AS cnt
        FROM events
        WHERE event_type = 'venue_card_opened'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_cut
        GROUP BY day
      ) x
    ),

    -- Daily action counts by type for bar chart
    'daily_actions', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('d', day, 'a', action, 'n', cnt) ORDER BY day, action),
        '[]'::jsonb
      )
      FROM (
        SELECT created_at::DATE AS day, metadata->>'action' AS action, COUNT(*) AS cnt
        FROM events
        WHERE event_type = 'venue_action_clicked'
          AND metadata->>'venue_id' = p_venue_id
          AND created_at >= v_cut
        GROUP BY day, action
      ) x
    )

  );
END;
$$;

-- Allow the anon (public) role to call this function
GRANT EXECUTE ON FUNCTION get_venue_insights(TEXT, INT) TO anon;
