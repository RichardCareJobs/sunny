# Sunny for Venues

The venue-facing advertiser platform: publicans claim their venue, run offers, and
see how many people are finding them.

Separate app from the consumer site. Its own entry point, its own build (there
isn't one), no shared runtime state. It shares only the Supabase project and the
brand.

**Status: Phase 1 — foundations.** Design tokens, the component library, Supabase
client and session plumbing, migration structure, and the Edge Function pattern.
No authentication screens, claiming, billing, offers or reporting yet — those are
Phases 2 through 7.

Open <http://localhost:8080/> after the setup below and you get the component
inventory: every component in the states the screens will use.

---

## Running it locally

No build step, no `npm install`, no bundler. Any static file server:

```bash
cd venues
python3 -m http.server 8080
# then open http://localhost:8080/
```

That is the whole setup. `venues/config.js` is committed with the Supabase URL
and anon key, so a clean checkout runs end to end with nothing configured — which
is what the brief asks for. To point at a different project locally, create
`venues/config.local.js` (git-ignored) and load it after `config.js`.

### Why the anon key is committed

It is public by design. It is sent to every browser that loads the site, it is
the same key `app.js` ships on the consumer site, and hiding it is neither
possible nor the point — row level security is what protects the data.

The keys that genuinely are secret — the Supabase service role key, the Stripe
secret key, the Twilio auth token — are not in this repo and never will be. They
live only in Supabase Edge Function secrets. See `.env.example`.

---

## Layout

```
venues/
  index.html            entry point; import map, vendored libs, config
  config.js             public runtime config (committed on purpose)
  CNAME                 venues.sunnypubs.app
  styles/
    tokens.css          the only file with colour, type, space and radius values
    base.css            reset and element defaults
    components.css      the component library's styles
  app/
    html.js             Preact + htm, wired once — the only file that knows the view layer
    config.js           reads window.SUNNY_VENUES_CONFIG, fails loudly if incomplete
    supabase.js         client, session persistence, expired-session handling, Edge Function calls
    store.js            tiny observable store: session, memberships, selected venue, toasts
    router.js           hash router
    ui/components.js    the component inventory
    ui/icons.js         inline SVG icons
    screens/shell.js    app shell: header, venue switcher, outlet
    screens/gallery.js  the component inventory page
    main.js             boot
  supabase/
    migrations/         versioned SQL — the only way schema changes happen
    functions/          Edge Functions (Deno)
      _shared/cors.ts   CORS, applied to every function
      _shared/http.ts   validation, error shape, logging
      _shared/env.ts    provider selection and the production stub guard
      health/           the first function, proving the pattern end to end
  vendor/               pinned third-party code, committed
```

### Splitting this into its own repo

It is already self-contained: nothing in `venues/` reaches outside it, and it has
its own icons, its own `CNAME` and its own `.gitignore`. Moving it is
`git mv venues/* ../sunny-venues/` and pointing GitHub Pages at the new repo.

**This will have to happen for the subdomain to work.** GitHub Pages allows one
custom domain per repository, and this repo's root `CNAME` is
`visit.sunnypubs.app`. `venues.sunnypubs.app` cannot be served from here. See
`docs/venues-platform-review.md` for the DNS and Pages checklist.

---

## Dependencies

Three, all vendored as pinned files rather than fetched from a CDN at runtime.
An authenticated app should not load code it cannot pin.

| What | Version | Size | Why |
|---|---|---|---|
| `preact` + `preact/hooks` | 10.26.9 | ~15KB | View layer for ~20 form-heavy authenticated screens |
| `htm` | 3.1.1 | ~1KB | JSX-like templates with no compile step |
| `@supabase/supabase-js` | 2.58.0 | ~137KB | Auth, PostgREST, Storage, Edge Functions |

`supabase-js` is the UMD build rather than an ES module because the published
ESM bundle is not self-contained — it reaches for `ws`, `buffer` and `process`.
The UMD file is the one that can be vendored honestly.

Preact and htm are loaded through an import map so application code imports
`"preact"`, not a path. Swapping the view layer later means editing
`app/html.js` and the import map, not the app.

---

## Design tokens

`styles/tokens.css` is the single source of truth. No component style contains a
raw hex value; if a colour is missing, add it there.

The palette is lifted from the consumer app's `style.css`, not invented: the
`#ff6a00` orange, `#111` ink, `#666` muted, `#136f63` green, `#f4c95d` amber,
`#c94f4f` red, the 10–16px radii and 999px pills, and the system font stack.

### Colour and contrast

Two deliberate deviations, both for accessibility, which the brief lists as
non-negotiable:

- **Primary buttons use `--brand-700` (`#b84400`), not `#ff6a00`.** White text on
  the brand orange measures 2.9:1 and fails AA at any size. `--brand-700` gives
  5.4:1 and still reads as Sunny.
- **The header carries near-black text on the brand orange, not white.** Same
  problem, different fix: keeping `#ff6a00` as the identity surface and putting
  `--ink` on it gives 6.5:1. The consumer app uses white here; this app does not.

Every text and background pair in the component library was measured. All pass
WCAG AA.

Dark mode is deliberately not implemented. The consumer app has no dark palette
to derive from, and inventing one would break "do not invent a new palette".
Everything is a token, so adding a dark set later is a one-file change.

---

## Migrations

All schema changes are versioned SQL files in `supabase/migrations/`, reviewable
in a diff. Nothing is clicked together in the dashboard.

```bash
# from the repo root, with the Supabase CLI linked to the project
supabase db push

# or apply one by hand in Dashboard → SQL Editor
```

### The two migrations in Phase 1 are NOT applied yet

Both touch the live database, which serves the consumer app. Read them before
running them.

| Migration | What it does | Before you apply |
|---|---|---|
| `20260831120000_venue_directory_columns` | Adds phone, address, country, coordinates and website to `venue_details` and backfills them from `venue_enrichment`. Additive and re-runnable. | Nothing. The consumer app writes none of these columns. |
| `20260831120100_events_place_id_backfill` | Fills `events.place_id`, which has never been written to, and adds the index reporting will need. | The consumer app's `analytics.js` should start writing `place_id` **first**, or new rows keep arriving unattributed. That is a separate one-line change in the consumer app. |

### Known issue to fix when Phase 2 opens sign-up

`get_venue_insights(text, int)` is `SECURITY DEFINER`, granted to
`authenticated`, takes an arbitrary venue id and performs **no membership
check**. It is harmless today — there is one auth user. The moment public
sign-up exists, every venue operator can read every venue's analytics.

It must be fixed in the same migration that opens sign-up: add a `venue_members`
check inside the function, or revoke it and replace it with a
membership-scoped version. Do not ship Phase 2 without it.

---

## Edge Functions

All server-side logic lives here. Stripe webhooks, Twilio calls, verification
code generation and comparison, and anything using the service role key run in
Edge Functions and nowhere else.

```bash
supabase functions serve health --env-file venues/.env.local
curl -X POST http://localhost:54321/functions/v1/health \
     -H "Content-Type: application/json" -d '{"echo":"hello"}'

supabase functions deploy health
```

Three rules the shared helpers enforce, so no function can get them wrong:

- **CORS.** Supabase adds CORS headers to REST and Auth but **not** to Edge
  Functions. `_shared/cors.ts` answers the preflight before any auth check —
  a preflight carries no `Authorization` header, so a function that
  authenticates first rejects its own preflight and the browser reports a CORS
  error that has nothing to do with CORS. The origin is echoed from an
  allow-list, never wildcarded, because these calls are credentialed.
- **Errors.** `_shared/http.ts` gives every error two audiences: plain language
  for the operator, structured context for our logs. An unexpected error never
  leaks its message to the browser.
- **Never trust a `place_id` from the client.** It is not proof of anything.
  Membership is re-derived from the JWT on every call.

---

## External services

Stripe and Twilio sit behind internal interfaces with two implementations each,
selected by environment variable. Both default to `stub`, so the whole app runs
end to end on a clean checkout with no third-party keys.

```
PAYMENTS_PROVIDER=stub | stripe
VOICE_PROVIDER=stub | twilio
```

With `DEPLOY_STAGE=production`, any provider still set to `stub` makes the
functions **refuse to start**. The voice stub returns the verification code in
its response, so a stub in production is a full authentication bypass. Failing
to boot is the correct behaviour.

### Twilio — start this now, it is the long pole

Needed in **Phase 3**, but the lead time is the longest of anything in this
build:

1. Create the Twilio account and verify the business.
2. Request an Irish (+353) number. This needs a **regulatory address bundle**
   with proof of an Irish address. Approval runs from business days into weeks.
3. Enable Programmable Voice and note the account SID, auth token and number.
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` as Edge
   Function secrets, then flip `VOICE_PROVIDER=twilio`.

An automated call to a Dublin venue from a foreign number gets hung up on, so
the Irish number is not optional. A London number will be needed for GB venues
on the same basis.

### Stripe — start during Phase 4

Needed in **Phase 5**. Business verification and bank details take days.

1. Create the account and complete business verification.
2. Create Products and Prices from the `plans` table rather than by hand, so
   the two cannot drift. Annual prices are generated as monthly × 12 × 0.85.
3. Add a webhook endpoint pointing at the Stripe webhook Edge Function, and
   subscribe to `checkout.session.completed`,
   `customer.subscription.created/updated/deleted`, `invoice.paid` and
   `invoice.payment_failed`.
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Edge Function
   secrets, put `STRIPE_PUBLISHABLE_KEY` in `config.js`, then flip
   `PAYMENTS_PROVIDER=stripe`.

---

## Supabase configuration to do by hand

Only the first two are needed now.

| Phase | Where | What |
|---|---|---|
| 1 | Authentication → URL Configuration | Site URL: `https://venues.sunnypubs.app` |
| 1 | Authentication → URL Configuration | Redirect allow-list: `https://venues.sunnypubs.app/**` and `http://localhost:8080/**`. Magic links and password resets both bounce off this list. |
| 2 | Authentication → Providers | Email enabled, "Confirm email" on. Email verification is required before a venue can be claimed. |
| 2 | Authentication → Rate Limits | Tighten sign-up and OTP limits. The brief requires rate limiting on auth and verification endpoints. |
| 2 | Authentication → Email Templates | Rewrite confirmation, magic link and reset emails in Sunny's voice. The defaults read like a SaaS product. |
| 6 | Storage | Bucket for offer images, with size and MIME validation. |

---

## Secrets by phase

| Phase | Secret | Where | Lead time |
|---|---|---|---|
| 1 | Supabase URL + anon key | `config.js` (public) | none |
| 1 | `SUPABASE_SERVICE_ROLE_KEY` | Edge Function secrets only | none |
| 3 | `VOICE_PROVIDER=stub` | Edge Function secrets | none, it is the default |
| 3 | Twilio SID / token / +353 number | Edge Function secrets | **weeks — start now** |
| 5 | `PAYMENTS_PROVIDER=stub` | Edge Function secrets | none, it is the default |
| 5 | Stripe secret + webhook signing secret | Edge Function secrets | days — start in Phase 4 |
| 5 | Stripe publishable key | `config.js` (public) | with the above |

---

## Build order

1. **Foundations** ← you are here
2. Auth and membership — sign-up, sign-in, magic link, verification, reset,
   `venue_members` with per-venue roles, invites, RLS policies
3. Search and claiming — venue search, claim flow, phone verification, abuse
   controls, admin review
4. Dashboard shell — navigation, venue switcher, account home, onboarding,
   listing management
5. Billing — plans table, pricing page, Checkout, webhooks, entitlements, comps
6. Offers — CRUD, scheduling, preview, entitlement gating, redemption schema
7. Reporting — rollup tables, venue and offer reporting, export

Each phase stops for review.

---

## Related

- `docs/venues-platform-review.md` — the pre-build review of the brief: the
  hosting constraint, the framework choice, five findings from the live data
  that change the plan, and the answers to the four open decisions.
