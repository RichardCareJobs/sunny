# Protecting the Google Maps key and capping Places spend

Sunny calls Google Places from the browser with the key in `index.html`, so anyone can copy it.
The app now has per-browser call caps (`js/tile-core.js` `createCallBudget`), but a script using
the key directly bypasses the app entirely. These Google Cloud Console settings are the real
backstop. They take about 15 minutes and need no code.

Docs: [API security best practices](https://developers.google.com/maps/api-security-best-practices),
[Manage costs](https://developers.google.com/maps/billing-and-pricing/manage-costs).

## 1. Restrict the browser key

Console → Google Maps Platform → Keys & Credentials → the key used in `index.html`:

- **Application restrictions → Websites**, add:
  - `https://sunnypubs.app/*`
  - `https://visit.sunnypubs.app/*`
  - any preview/staging origin you actually use (and `http://localhost:*/*` only on a separate dev key)
- **API restrictions → Restrict key**, allow only:
  - Maps JavaScript API
  - Places API (New)

A referrer restriction can be faked by a determined script, so it stops casual key reuse, not
targeted abuse. That's what the quotas below are for.

## 2. Hard daily caps (the only thing that actually stops spend)

Console → Google Maps Platform → Quotas → Places API (New). Lower the **per day** limit for each
method. When a cap is hit, that request type fails for the rest of the day (resets at midnight
Pacific time, which is mid-afternoon/evening in Australia), and Sunny shows "Couldn't load
venues".

Suggested starting points (busiest real day so far was 19 Nov 2026: ~5,600 Text Search,
~1,700 Nearby, ~1,000 Place Details before the cost fixes):

| Method (as shown in Quotas) | Suggested per-day cap | Worst-case list price/day at cap |
|---|---|---|
| Text Search | 4,000 | ~US$128 |
| Nearby Search | 1,500 | ~US$48 |
| Place Details (GetPlace) | 2,000 | ~US$40 |
| Place Photos (GetPhotoMedia) | 1,500 | ~US$11 |

Tune these after a week of `docs/places_call_diagnostics.sql` data: roughly 2× the busiest
normal day. Lower caps mean a smaller worst case but a higher chance a genuine traffic spike
(like 19 Nov) hits the limit.

## 3. Budget alerts (warn only, never stop spend)

Console → Billing → Budgets & alerts → Create budget, scoped to the Sunny project:
alerts at A$50, A$100 and A$150 per month, emailed to you. Google bills can lag by up to
48 hours, so check `docs/places_cost_reporting.sql` for a same-day estimate.

## 4. Later: server-side proxy + Turnstile (plan step 3c)

Moving map searches behind a Supabase Edge Function with Cloudflare Turnstile and a shared
search cache would let the browser key drop Places search access entirely. Planned once a week
or two of diagnostic data is in.
