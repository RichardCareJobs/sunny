# Sunny for Venues — response to the build brief

Written before any platform code exists, as section 8 and section 10 of the brief ask for.
Everything in the "What the data actually says" section is measured against the live Supabase
project (`ivylljoqjswkuyrpevmg`) on 2026-08-31, not inferred from the repo.

There are two things I can't start Phase 1 without an answer on (hosting, framework). Everything
else below is a recommendation you can accept, reject, or park.

---

## 1. Two things that block Phase 1

### 1.1 `venues.sunnypubs.app` cannot be served from this repo

`CNAME` in the repo root is `visit.sunnypubs.app`. GitHub Pages allows **one custom domain per
repository**, and the `CNAME` file is that domain. There is no configuration that serves a second
custom domain from the same Pages site.

The brief says "set it up so it can be split into its own repo later without rework." Given the
above, the split isn't a later option — it's the only way to get the subdomain at all. So we should
do it now, which costs nothing and removes the rework entirely.

**Recommendation:** a new repo, `RichardCareJobs/sunny-venues`, GitHub Pages, its own `CNAME`.
Same hosting model, same Supabase project, no shared runtime state — exactly what the brief asks
for. (The alternative, if you'd rather keep one repo, is Cloudflare Pages for the venues app, which
can serve a subdomain from a subdirectory of an existing repo. It adds a second host to your stack;
I'd avoid it.)

**Exactly what you configure, once the repo exists:**

| Where | Setting |
|---|---|
| DNS (your registrar / DNS host) | `CNAME` record, name `venues`, value `richardcarejobs.github.io.` — a CNAME, not an A record. TTL 3600. Do not proxy it if you're on Cloudflare DNS, or Pages can't issue the cert. |
| Repo | File `CNAME` in the publishing root containing exactly `venues.sunnypubs.app` |
| Repo → Settings → Pages | Custom domain: `venues.sunnypubs.app`. Wait for the green check (cert issuance, usually minutes, occasionally an hour). |
| Repo → Settings → Pages | Tick **Enforce HTTPS** once the cert is issued. Not before — it's greyed out until then. |
| Supabase → Authentication → URL Configuration | Site URL: `https://venues.sunnypubs.app` |
| Supabase → Authentication → URL Configuration | Redirect allow-list: `https://venues.sunnypubs.app/**` and `http://localhost:8080/**` for local dev. Magic links and password-reset links both bounce off this list — get it wrong and the link silently lands on the wrong origin. |

**On CORS specifically**, because the brief asks to get it right up front: Supabase's REST and Auth
endpoints send `Access-Control-Allow-Origin: *` and need no configuration. **Edge Functions do
not.** Supabase adds no CORS headers to Edge Functions for you. Every function we write has to:

- answer `OPTIONS` with `204` and the allow headers, before any auth check runs
- echo the request `Origin` only if it's on our own allow-list (`venues.sunnypubs.app` + localhost),
  never `*`, because these functions are credentialed
- send `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type`

That's a shared helper in Phase 1, applied to every function from the first one. It's the single
most common way this goes wrong and it's entirely preventable.

### 1.2 Framework — I think a small one is justified, and I want your call

The brief says say so before writing code, so: **I'd vendor Preact + htm (about 6KB, two files,
pinned, committed to the repo) and use it, rather than write vanilla.**

The argument isn't "vanilla can't do it" — it obviously can. The argument is that this app is
roughly twenty authenticated screens with forms, optimistic updates, a venue switcher that changes
the meaning of every screen, and validation state everywhere. The hand-rolled alternative is a
render-and-diff layer we write ourselves. `app.js` in this repo is 292KB in a single file and is
the honest preview of where that ends up.

What this does *not* mean: no build step, no bundler, no `node_modules` at deploy, no CDN at
runtime. It stays a static site you can open from `file://`. `htm` gives JSX-like templates inside
ordinary tagged template literals, compiled at runtime, so there is nothing to compile.

The genuine case for vanilla: it matches the existing codebase, it's one less thing for you to
learn if you ever edit this yourself, and it keeps the dependency count at literally zero. If you
value that more than the ergonomics, say so and I'll write vanilla with ES modules, a small router,
and strict per-screen file separation — it will work, it will just be more code and more of my
time.

Either way, `@supabase/supabase-js` is a dependency (vendored the same way). There is no sane path
to hand-rolling auth token refresh.

---

## 2. What the data actually says — five findings that change the brief

These are the reason I'd rather have this conversation now than in Phase 3.

### 2.1 `venue_details` is a cache, not a canonical directory

The brief describes `venue_details` as "canonical, keyed on `place_id`" and builds venue search on
it. It isn't canonical. From `app.js`'s own comment: *"populated whenever anyone opens a venue."*

Measured:

- `venue_details` holds **2,571** rows.
- In the last 30 days, events referenced **5,688** distinct venues.
- **4,951 of those 5,688 (87%) are not in `venue_details` at all.**

Venues appear on the map from live Google Places results and only land in the table once a user
opens them. So a publican searching for their own pub will, most of the time, not find it — and
land in the "Can't find your venue?" prospect-capture path, which the brief correctly designs as
the rare exception. It would be the majority case.

**Recommendation.** Two changes, both cheap:

1. Build a real directory by backfilling Dublin and London once (Places or the existing Apify
   pipeline), into a proper table with the columns claiming actually needs. Keep it refreshed on a
   schedule, not on user traffic.
2. Allow **one** Places Text Search at the moment a claim search misses, writing the result into
   the directory. The brief's cost objection is about per-consumer-session calls, and it's right
   about those. A call per *claim attempt* is a different order of magnitude — even a thousand
   claim attempts is a rounding error, and it's the difference between the flow working and not.

### 2.2 The phone number the claim flow depends on is not in `venue_details`

Section 3.2 makes automated phone verification the sole gate, using "the publicly listed phone
number already held in `venue_details`." There is no phone column on `venue_details`. The numbers
exist in `venue_enrichment.raw` (`phone` / `phoneUnformatted`), from Apify.

Coverage: **1,139 of 2,571 venues (44%)** have a phone number. For the 87% not in the directory at
all, it's zero.

So as specified, the automated gate is unavailable for the majority of claims, and the majority
route to manual review — which is precisely the outcome automating it was meant to avoid.

**Recommendation.**

- Promote real columns onto the directory: `phone_e164`, `phone_source`, `formatted_address`,
  `country_code`, `lat`, `lng`, `website`. Backfill from `venue_enrichment.raw` (which has
  `address`, `street`, `city`, `postalCode`, `countryCode`, `website`, `location` — all present).
  `country_code` is also what derives EUR vs GBP for pricing, so it earns its place twice.
- Normalise to E.164 at write time. `phoneUnformatted` is not reliably E.164 and Twilio will
  reject or misroute it.
- Raise coverage in the backfill — the Places API returns `internationalPhoneNumber`, which the
  current pipeline doesn't capture.
- Add a **second automated gate** for phone-less venues rather than defaulting them to manual:
  email verification to an address on the domain of the venue's **listed website** (present in the
  enrichment data). It's still not user-supplied, which is the security property that matters, and
  it converts a large slice of manual reviews into automated ones.

One more thing about the voice call: a fair number of small venues list a **mobile**. Twilio Lookup
can tell us the line type for pennies, and where it's a mobile, SMS will land far more reliably
than a TTS call to a phone behind a bar mid-service. Worth having both paths.

### 2.3 `events.place_id` has never been populated

**0 of 78,376** `venue_view` rows have `place_id` set. The venue id lives in
`metadata->>'venue_id'`. The foreign key and the index on `events.place_id` are dead weight, and
every reporting query in Phase 7 would have to go through an unindexed JSONB extraction over a
table that is already 92,845 rows and growing.

**Recommendation.** Fix it in Phase 1's first migration, while the table is small: backfill
`place_id` from `metadata->>'venue_id'`, and correct `analytics.js` in the consumer app to write
the column going forward. Trivial now, genuinely painful at ten million rows.

### 2.4 Traffic is far below what the reporting tier can honestly sell

This is the finding I'd most want you to push back on if you disagree, because it's commercial
rather than technical.

Last 30 days, per venue:

| Metric | Median | p90 | Max | Venues reaching 20+ |
|---|---|---|---|---|
| Listing views | 1 | 4 | 107 | 84 of 5,688 (1.5%) |
| Detail opens | 0 | — | 6 | **0** |

The brief's own honesty rule — label anything under ~20 events as indicative rather than showing a
precise-looking percentage — is correct, and it would fire on essentially every metric for
essentially every venue. Standard at €79/month lists "full reporting" as its headline
differentiator. Today that buys a dashboard reading "1 view, 0 detail opens, indicative."

I'd still build reporting exactly as specced. It's the right design, the honesty rules are right,
and it compounds as traffic grows. But I don't think it can carry the price yet, and I'd rather say
that now than build it and watch it not convert. **Offer distribution is what Standard sells.**
Reporting is what makes them stay once the numbers are real.

Related, and a hard dependency: section 6 asks for directions taps, phone taps, website taps, and
saves. `venue_action_clicked` has **17 rows in all time**, and there is no save event at all. Those
metrics need instrumenting in the **consumer** app, and that work has to land well before Phase 7
or the reporting screens will have nothing but empty states to render. Same for "search
impressions" — no search event is logged today.

### 2.5 A live security hole that opens the moment we allow sign-up

`get_venue_insights(p_venue_id text, p_days integer)` is `SECURITY DEFINER`, granted to
`authenticated`, takes an arbitrary venue id, and performs **no membership check**. Today that is
harmless: `auth.users` contains exactly one row — you.

Phase 2 opens public sign-up. At that moment, every publican who signs up can pull full analytics
for **any venue in the system**, which is a direct breach of section 6's "only ever show a venue
its own data."

**This must be fixed in the same migration that opens sign-up, not after.** Either add a
`venue_members` check inside the function, or revoke it and replace it with a membership-scoped
version. It's a ten-line fix and an unbounded problem if missed.

Second, smaller one in the same family: `venue_details` currently has RLS policies allowing
**anyone** — including anonymous browsers — to insert and update. We're about to sell "listing
control" on the free tier, writing to a table any visitor can overwrite. Rather than fight the
consumer app's upsert path, I'd add a separate `venue_listing_overrides` table, owned by the
operator and scoped by `venue_members`, which the consumer app reads with precedence over the
cache. Clean separation, and zero changes to the consumer write path.

---

## 3. Answers to your four open decisions

### 3.1 Vanilla or a framework
Covered in 1.2. Recommendation: vendored Preact + htm, no build step. Your call.

### 3.2 First-class `organisations` entity?
**Your instinct is right — don't build it.** "The set of venues a user belongs to" is sufficient
for v1 and an org hierarchy for a handful of accounts is a lot of layer for very little.

One hedge that costs nothing now and saves the migration later: put billing on a
**`billing_accounts`** table (one row per Stripe customer) and have `venue_subscriptions` reference
*that*, not `user_id` directly. A "group" later is just a billing account with several members —
no subscription rows move, no schema change. Referencing `user_id` from subscriptions is the
decision that would be expensive to reverse.

### 3.3 Two people claim independently, then want to merge
Don't build merging. Four properties keep it a data migration rather than a schema change later:

1. Everything venue-scoped resolves through `venue_members`, never through `user_id` directly —
   the brief already requires this.
2. Subscriptions point at a `billing_account_id` (3.2 above). Merging then means repointing billing
   accounts, not rewriting subscription history.
3. `venue_claims` is append-only and immutable, with `claimed_by_user_id` kept as history. A merge
   never has to rewrite the audit trail of who claimed what and how.
4. Memberships **soft-delete** (`removed_at`), never hard-delete or cascade. A merge can then
   reconstruct who had access at any point in time.

With those four in the first migration, merging later is a script.

### 3.4 Is a plan transferable when a venue changes hands?
**Not automatically — but make it a first-class admin action, not a database edit.**

The failure mode that matters is silently continuing to bill an old licensee for a pub they sold.
That's a chargeback and a bad story, and it's what automatic transfer produces.

Proposed rule:

- Ownership moving **within the same billing account** (adding a co-owner, an area manager
  handover) — plan continues untouched. This is the common case and it should be frictionless.
- Ownership moving to a **different billing account** (pub actually sold) — the old subscription
  cancels at period end, the new owner subscribes fresh, and you can grant a comp period to bridge
  the gap using the founding-venue comp mechanism already in the brief. No new machinery.

With `billing_account_id` on the subscription and the claim history immutable, this is a two-row
change plus one admin screen.

---

## 4. Other things in the brief worth flagging

- **Twilio Irish numbers have the longest lead time of anything here.** A +353 number requires a
  regulatory address bundle with proof of an Irish address, and approval is measured in business
  days to weeks. You are right that a foreign caller ID gets hung up on. **Start this now** — it is
  the only external dependency that can block a phase outright, and Phase 3 is early.
- **Stripe** needs business verification and bank details, typically days. Start it before Phase 4
  ends; it won't block Phases 1–4 given the stub adapter.
- **"Claimed listing €0 — no offers."** I'd give the free tier one always-on offer slot. A free
  tier with zero offers gives a publican no reason to open the app a second time, which means no
  habit and no engagement data from the accounts most likely to upgrade. Commercial opinion, not a
  technical objection — flagging it, not arguing it.
- **The offer preview has a dependency the brief doesn't name.** Section 5 wants a live preview
  showing "exactly how the offer will appear in the consumer app." The consumer app has no offer
  surface at all today. Something has to be designed and built there before that preview can be
  honest. That's consumer-app work sitting on Phase 6's critical path.
- **Annual pricing from a stored discount rate** — agreed, and worth noting Stripe still needs two
  Price objects per plan. The rule is that the annual Price is *generated from* monthly × 12 × 0.85
  at plan-creation time; the database stores only the monthly price and the rate, so the two can
  never drift.
- **Repo hygiene:** `sunny-main` is an empty file and `sunny-v2.8.2-enrichment/` is a stale full
  copy of the consumer app. Worth deleting. Unrelated to this build, but if you'd rather I didn't
  touch the consumer app, say so and I'll leave them.

---

## 5. Secrets, by phase

Only the first row is needed before I can start.

| Phase | Secret | Where it goes | Lead time |
|---|---|---|---|
| 1 | Supabase URL + anon key | Frontend config (public by design — same key the consumer app ships) | None, have it |
| 1 | Supabase service role key | Edge Function secrets **only** — never the repo, never the browser | None |
| 3 | `VOICE_PROVIDER=stub` | Edge Function secret | None — this is the default |
| 3 | Twilio account SID, auth token, +353 number | Edge Function secrets | **Weeks.** Start now |
| 5 | `PAYMENTS_PROVIDER=stub` | Edge Function secret | None — this is the default |
| 5 | Stripe secret key, webhook signing secret, publishable key | Secret + signing secret to Edge Functions; publishable key to frontend | Days. Start during Phase 4 |

Both providers default to `stub`, and a stub refuses to start if the deployment stage is
production — the brief is right that a stub reaching production is a full authentication bypass,
and it's worth failing loudly rather than cleverly.

---

## 6. What I'd do in Phase 1, on approval

1. New repo, Pages, `CNAME`, and the DNS/HTTPS checklist in 1.1 confirmed working end to end.
2. Design tokens lifted from the consumer app — the orange `#ff6a00`, near-black `#111`, muted
   `#666`, `#136f63` green, `#f4c95d` amber, `#c94f4f` red, the 10–16px radii and 999px pills, the
   system font stack. One token file, no hex in component styles.
3. Component inventory built before any screen: button, input, select, card, table, empty state,
   toast, modal, sheet, venue switcher. Mobile-first, keyboard-navigable, focus states that meet
   contrast.
4. Supabase client wiring with session persistence and refresh, and an explicit expired-session
   path that surfaces rather than fails silently.
5. Migration structure, the CORS helper, and the two data fixes above that get cheaper the earlier
   they happen: `events.place_id` backfill, and the directory columns.

Then I stop and show you.
