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

## 6. What's transferable to Sunny

If we want a "secure deals with restaurants" feature that resists the usual
failure modes (fake coupons, no-shows, staff friction, restaurants under- or
over-committing):

1. **Make deals supply-triggered, not calendar-triggered** — let venues
   toggle a deal on/off in real time tied to actual availability, with a
   cap on quantity, rather than a static always-on discount.
2. **Avoid staff-facing redemption codes if at all possible.** A
   card-linked-offer model (EatClub Pay) is the strongest anti-fraud
   design because the discount is enforced by the payment rail, not by a
   human checking a screen. Building this ourselves means either:
   - Partnering with a card-linked-offer provider (e.g. **Cardlytics**,
     **Fidel API**, or issuing our own prepaid virtual card via a program
     like **Marqeta/Stripe Issuing**), or
   - Falling back to a simpler but weaker model (single-use redemption
     code/QR tied to a specific user+venue+time, invalidated instantly on
     use, shown to staff) if a card-linked integration is out of scope for
     v1.
3. **Charge restaurants a flat/subscription fee for marketplace access**
   rather than a scary per-order commission — lowers the trust barrier for
   independent restaurants to opt in versus a Groupon-style deep-discount
   commission model.
4. **Some form of no-show deterrent** for claimed-but-unused dine-in offers,
   sized carefully to avoid the consumer-law/backlash issues EatClub has
   hit.
5. **Basic venue vetting at onboarding** (capacity, insurance, hygiene
   rating) to protect deal quality and avoid restaurants publishing offers
   they can't fulfill.

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
