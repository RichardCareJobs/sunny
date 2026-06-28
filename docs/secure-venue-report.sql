-- ═══════════════════════════════════════════════════════════════════════════
-- Secure the Venue Insights report
-- ───────────────────────────────────────────────────────────────────────────
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- It is safe to re-run.
--
-- WHAT THIS DOES
--   Locks the detailed per-venue analytics function (get_venue_insights) so it
--   can only be called by a signed-in (authenticated) user. The venue-report
--   page now signs in with Supabase Auth, so it gets the `authenticated` role.
--
-- WHY THIS IS THE REAL FIX
--   The Supabase anon key shipped in the page is PUBLIC by design (it is the
--   same key the main public site uses). Hiding it is neither possible nor the
--   point. Before this change, the old page password lived only in client-side
--   JavaScript, so anyone could read it — or skip it entirely with a ?v=… link
--   — and then call this function with the public anon key. Restricting the
--   function to the authenticated role is what actually closes that hole.
--
-- WHAT IS DELIBERATELY LEFT PUBLIC (and why that's fine)
--   • get_homepage_stats()  — the main public app (sunnypubs.app) calls it for
--                             its "Suns Out" feature; that data is already
--                             public there.
--   • venue_details (SELECT) — the public app reads venue names/addresses to
--                             render the map; that data is public anyway.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Restrict the detailed per-venue analytics to signed-in users only.
REVOKE EXECUTE ON FUNCTION get_venue_insights(TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_venue_insights(TEXT, INT) FROM anon;
GRANT  EXECUTE ON FUNCTION get_venue_insights(TEXT, INT) TO authenticated;

-- 2) (Verify) Confirm anon can no longer call it. This should return NO rows:
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_name = 'get_venue_insights' AND grantee = 'anon';


-- ═══════════════════════════════════════════════════════════════════════════
-- TWO MANUAL STEPS in the Supabase Dashboard (these cannot be done in SQL)
-- ───────────────────────────────────────────────────────────────────────────
--
-- A) CREATE YOUR LOGIN
--    Authentication → Users → "Add user" → "Create new user"
--      • enter your email + a strong password
--      • tick "Auto Confirm User" so you can sign in immediately
--    Then sign in on the report page with that email + password.
--
-- B) DISABLE PUBLIC SIGN-UPS  (IMPORTANT)
--    Authentication → Sign In / Providers (or Settings) → turn OFF
--    "Allow new users to sign up".
--    If you skip this, anyone could self-register an account and then call
--    get_venue_insights — which would defeat the lock-down above. With sign-ups
--    off, only the user(s) you create in step A can sign in.
-- ═══════════════════════════════════════════════════════════════════════════
