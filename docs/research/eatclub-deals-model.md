# How EatClub secures restaurant deals & coupons

Research notes on EatClub's restaurant-facing deal model, as a reference for
building a similar "deals" feature in Sunny. EatClub operates in Australia,
UK, and (as a related but distinct US business, "EAT Club") corporate
catering — the notes below are about the AU/UK dynamic-discount app, which is
the closest analog to what we'd want for Sunny.

## 1. The core idea: supply-driven, not coupon-driven

EatClub deals aren't static "10% off" coupons a restaurant sets once. They're
**dynamic, real-time offers restaurants publish only when they have spare
capacity** — an empty table tonight, a slow Tuesday lunch, surplus food
before close. The restaurant decides moment-to-moment whether a deal exists
at all, which is what keeps supply (empty seats) matched to demand
(discount-seeking diners) instead of just eating margin on tables that
would've filled anyway.

## 2. Deal creation flow (restaurant side)

Via the separate **"Partners at EatClub"** app:
1. Open the app, pick a discount tier (10% / 15% / 20% / a time-boxed
   "Lightning Deal", etc.).
2. Set a quantity (how many covers/orders the deal is good for).
3. Tap publish — live on the customer app in seconds.
4. Restaurant can edit today's quantity, pause all offers instantly, or
   disable an offer mid-window if they get busier than expected.
5. No pre-scheduling required, no cost to list a deal — EatClub monetizes via
   a subscription (see §5), not a listing fee.
6. EatClub also layers an **AI recommendation tool** that predicts likely
   uptake by time-of-day/venue-type/history, to help the restaurant pick a
   discount level that'll actually move covers instead of guessing.

This "publish only when you have room, revoke any time" control is itself a
big part of the trust story — restaurants aren't locked into a static
percentage they regret when they get busy.

## 3. Redemption security: card-linked offers, not coupons

This is the most interesting/transferable piece. EatClub does **not** use
scannable QR codes, printed vouchers, or a redemption code the restaurant
manually applies (all of which are easy to screenshot-share, reuse, or
socially-engineer). Instead:

- The customer claims an offer in-app, then pays with **"EatClub Pay"** — a
  virtual, prepaid Mastercard issued into Apple Wallet / Google Wallet,
  linked back to the customer's real card/bank account.
- At the table, the customer just taps the EatClub card on the normal
  EFTPOS/card terminal like any other payment. The terminal shows the
  **full, undiscounted bill** — the restaurant's POS and staff see a normal
  transaction, nothing to comp or apply manually.
- EatClub's backend intercepts the payment behind the scenes: it settles the
  discounted amount, and only charges the customer's real linked
  payment method for `bill − offer` (plus a small service fee). The
  customer gets a confirmation of the actual amount charged after the fact.
- Net effect: **redemption = a real card payment**, not a token that can be
  forged, duplicated, or redeemed twice. Fraud surface (fake screenshots,
  reused codes, "I showed the waiter already" disputes) mostly disappears
  because the discount is enforced financially, not by staff at checkout.
- The restaurant still gets paid the discounted price directly (or, per some
  models, the full price is settled to them and EatClub's margin/rebate is
  worked out on the backend) — either way the restaurant doesn't have to
  trust a paper coupon or manually apply a percentage.

For **takeaway/pre-order deals** (not tap-to-pay in person), the model shifts
to standard claim-in-app → order details pushed to the restaurant with
customer + order specifics, so the venue knows exactly who's coming and what
they ordered before they arrive.

## 4. Deal-abuse guardrails (customer side)

- **No stacking**: EatClub deals can't be combined with other third-party
  discount platforms (e.g. Groupon, Entertainment Book). If EatClub detects
  an attempt, it auto-removes the competing discount and applies its own.
- **No-show fee**: EatClub charges a small fee (reported ~$6 AUD) when a
  customer claims a dine-in offer and doesn't show, to discourage
  claim-and-abandon behavior that wastes a restaurant's held capacity. This
  has drawn some customer pushback/controversy around consumer-law
  compliance, worth noting if we copy it.
- **Quantity caps** set by the restaurant per deal prevent a single offer
  from being over-claimed beyond what the kitchen/floor can handle.

## 5. Restaurant-side commercial model

- **Subscription, not per-deal listing fee.** Public AU pricing (as of
  research date):
  - Essential — $49/mo: marketplace + AI predictions + tablet + account
    manager (+$10/mo optional lite booking widget).
  - Premium — $99/mo: marketplace + full-featured booking system bundled.
  - Bookings-only — $149/mo.
  - All plans cancel-anytime, no long lock-in contract advertised.
- Exact per-transaction commission (if any on top of the subscription) isn't
  publicly disclosed — likely negotiated/variable and disclosed at
  onboarding, similar to most of these platforms.
- Sign-up gating mentioned in partner materials: minimum production capacity
  (reports cite ~150 meals/day), general liability insurance, and food
  safety/inspection rating thresholds — i.e. EatClub vets restaurants before
  onboarding rather than being fully self-serve.

## 6. Card-linked offers: considered, and ruled out for Sunny

EatClub Pay (§3) is the strongest anti-fraud design of the options surveyed
— the discount is enforced by the payment rail, not a human checking a
screen — but on discussion it's a bad fit for Sunny and **we're not pursuing
it**:

- **Mismatch of effort to reward.** Sunny's offers are trivial-value (a
  pint-for-half-pint, $5 off a main), not the kind of saving worth
  provisioning a whole new virtual card for. Card-linked programs generally
  see a majority of users never activate/complete setup in the first place
  (general card-linked-offer industry data: ~57% of issued cards ever get
  activated at all) — that setup tax isn't worth paying for a low-value
  discount.
- **Repeated trust friction, not just a one-time cost.** Every redemption
  shows the customer the *full, undiscounted* bill on the terminal and asks
  them to trust an invisible backend to true it up afterward. That's a
  leap of faith paid on every visit, not just the first — and real EatClub
  Pay reviews show this trust breaking in practice (terminal shows
  "declined" while the bank shows a charge went through, confusion/refund
  disputes over whether the discount actually applied).
- **Tourist/overseas-card friction.** A meaningful share of Sunny's users
  are likely to be visitors on foreign cards — adding a second virtual card
  with its own currency/FX handling on top of an already-foreign primary
  card is a bad ask for a small discount.
- Building it ourselves would also mean either partnering with a
  card-linked-offer provider (Cardlytics, Fidel API) or standing up our own
  card-issuing program (Stripe Issuing/Marqeta) — a lot of build and
  compliance surface for a feature that's meant to stay simple.

## 7. Sunny's chosen direction: venue self-serve QR offers

Landed on instead: **QR-code redemption, with offers authored by venues
themselves, and (later) direct POS integration** — closer to the
old-fashioned "show the code, staff mark it used" pattern, but made safe
against reuse the same way modern coupon platforms do it (see e.g.
[Coupon Carrier](https://www.couponcarrier.io/qr-redemption-system/),
[Voucherify's QR playbook](https://www.voucherify.io/blog/use-qr-codes-to-integrate-promotions-in-your-mobile-app)),
not the old print-a-static-code way.

**QR technique.** There are two real approaches in the wild:
- *Static image, live-checked token* — the QR encodes a unique token; a
  backend tracks its status (`valid` / `used` / `expired`) and flips it to
  `used` atomically on redemption. A screenshot becomes useless once
  redeemed, because the token dies server-side, not because the image
  changes. This is what most coupon platforms do, and needs no special
  hardware — staff just open a scanner *webpage* on any phone.
- *Rotating/regenerating image* — e.g. Ticketmaster SafeTix, where the
  barcode pixels regenerate every ~15s from a shared secret (TOTP-style),
  defeating even a screenshot forwarded to someone else before the
  original claimer redeems it. Built to fight ticket-resale fraud on
  high-value items.
- **Decision: static token is enough for Sunny.** Rotating-image tech is
  solving a higher-stakes problem (resold concert tickets) than a
  pint discount getting texted to a mate before it's used. Not worth the
  engineering cost.

**Data model — two tiers**, so an offer's identity and a redemption's
identity aren't conflated:
- **Offer** (venue-authored, self-serve): `venue_id`, title, discount
  details, active days/times, quantity cap, on/off toggle. Venues manage
  this themselves through their own login, the same shape as EatClub's
  Partner app (pick the deal, set a cap, publish/pause any time).
- **Claim** (generated per user, per redemption — this is the actual QR):
  minted the moment a user taps "claim": `claim_id` (the token encoded in
  the QR), `offer_id`, `venue_id` (copied down from the offer), `user_id`,
  `status`, `claimed_at`, `expires_at`.
- Because a claim row already carries both `user_id` and `venue_id`, the
  same QR is structurally incapable of working at a different venue or for
  a different user — it was never generated for anything else. The
  redemption check isn't just "is this token valid," it's "is this token
  valid **and does its `venue_id` match the venue account that's scanning**"
  — so venue staff logins are scoped to their own venue's redemptions only.
- **Implementation gotcha to remember:** the "mark as used" step must be an
  atomic, conditional update (`UPDATE ... SET status='used' WHERE
  status='valid'`), not read-then-write, or two near-simultaneous scans of
  the same screenshot can both succeed.
- `expires_at` on the claim doubles as a no-show deterrent (an unused claim
  just goes stale) without needing EatClub's no-show-fee approach, which
  has drawn consumer-law criticism.

**POS integration — phase 2, not v1.** There's no unified POS API; Square,
Toast, Clover, Lightspeed etc. each have their own (and even differ on
basics — Clover, for instance, doesn't support post-tax discounts the way
you'd expect, custom discounts often have to ride in as a "custom tender").
Two realistic paths when we get there:
- An aggregator (Omnivore, Olo, POS Linker) normalizes multiple POS
  systems behind one API, at the cost of a vendor fee/dependency.
- Direct integration per platform, prioritized by whichever POS venues
  actually run.
Sequencing: ship QR + manual staff confirm first (works everywhere, zero
integration lift), add POS sync per-platform later only where it buys
something real — auto-expiring codes, auto-applying the discount at
checkout, reconciling payouts without manual keying.

## Sources
- https://eatclub.com.au/partners
- https://eatclub.com.au/partners/faqs
- https://eatclub.com.au/partners/pricing
- https://eatclub.co.uk/blog/introducing-eatclub-pay
- https://sales.eatclub.com.au/knowledge-base-faq/how-to-set-up-an-eatclub-card
- https://apps.apple.com/au/app/partners-at-eatclub/id1163476050
- https://apps.apple.com/gb/app/eatclub-restaurant-deals/id1053752571
- https://www.thecaterer.com/news/eatclub-lands-in-london
- https://glamadelaide.com.au/ssshhh-heres-how-you-can-secretly-score-huge-dining-discounts-with-eatclubs-latest-innovation/
- https://www.getkard.com/blog/clos-the-what-and-why (card-linked-offer activation benchmarks)
- https://www.couponcarrier.io/qr-redemption-system/
- https://www.voucherify.io/blog/use-qr-codes-to-integrate-promotions-in-your-mobile-app
- https://conduition.io/coding/ticketmaster/ (SafeTix rotating-barcode reverse-engineering)
- https://community.clover.com/questions/2438/custom-app-to-process-coupons-with-qr-codes.html
- https://pos-linker.com/blog/toast-api-integration-complete-guide
