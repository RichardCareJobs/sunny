# Brief: A/B test the venue card actions (Rows vs Button)

**For:** Claude Code, working in the Sunny app repo (served at visit.sunnypubs.app)
**Owner:** Richard
**Experiment ID:** `card_actions_v1`
**Length:** at least 28 days from go-live (see "When to stop")

---

## 1. Why we're doing this

The venue card's lower section currently shows either a **"Walk · 9 min"** button (when the venue is close by) or an **Uber** button (when it's further away), plus a text link for the other option. People don't realise the walk button opens directions, and few people tap either action.

Baseline from Supabase (production, last 30 days to 27 Nov 2026):

| Measure | Value |
|---|---|
| Sessions that opened a venue card | 550 |
| ...of which tapped Directions or Uber | 27 (**~4.9%**) |
| `venue_card_opened` events | 1,739 |
| `venue_action_clicked` events | 32 |

Note that some of this traffic is Richard testing it himself.

We're testing two redesigns of the card's lower section against each other. Both make it clear **what each action does and which app it opens**.

## 2. The two variants

Both variants share the same **flat trip line** at the top of the action section. The line is plain grey text with no box and no bold, and isn't a button:

`● You ········ 🚶 9 min walk ········ 📍 Pub` (close by)
`● You ········ 3.1 km away ········ 📍 Pub` (further away)

Everything below that line is what differs.

### Variant `rows` (canvas name "B2")
Two full-width tappable rows. The recommended action comes first and is highlighted (orange border, tinted background, filled icon circle).

| | Row 1 (highlighted) | Row 2 |
|---|---|---|
| Close by | 🚶 **Walking directions**: "Step-by-step in Google Maps", chevron › | 🚗 **Uber**: "Book a ride in the Uber app", external-link icon |
| Further away | 🚗 **Uber**: "Book a ride in the Uber app", external-link icon | 📍 **Directions**: "Drive or transit in Google Maps", chevron › |

### Variant `button` (canvas name "D2")
One large primary button, plus a sentence with a text link underneath.

| | Primary button | Text link line |
|---|---|---|
| Close by | ➤ **Directions in Google Maps** | "Rather not walk? **Book an Uber**" |
| Further away | 🚗 **Book an Uber** ↗ | "Driving yourself? **Get directions**" |

**Reference files** are in `reference/`:
- `reference/reference.html`: a static page showing both variants, close by and further away. Open it in a browser. It's the visual source of truth.
- `reference/card-actions.css`: the styles. All classes are prefixed `sca-`.
- `reference/card-actions.js`: a plain-JS reference for variant assignment, HTML rendering and the analytics metadata helper.

Adapt the reference code to the app's existing patterns (file layout, how venue cards are rendered and how events are tracked). Don't drop it in blindly. Keep the visual result identical to `reference.html`.

## 3. What to build

1. **Find the current card action code.** Locate where the venue card renders the Walk/Uber button and text link. Also find the close-by/further-away rule (the distance threshold) and how the directions and Uber URLs are built. **Reuse all of that unchanged.** The URLs, deep links, `target` behaviour and the threshold must not change. Only the presentation changes.
2. **Assign a variant per browser, and keep it.**
   - Split 50/50 at random on first card render. Store it in `localStorage` under `sunny_exp_card_actions_v1`, so a returning visitor always sees the same variant.
   - Wrap `localStorage` in try/catch. If storage is unavailable, assign for the page view only and set `exp_sticky: false` in metadata.
   - QA override: `?card_actions=rows` or `?card_actions=button` forces a variant, stores it, and marks the browser `exp_forced: true`.
   - Internal-traffic flag: `?internal=1` sets `localStorage.sunny_internal = "1"`, and `?internal=0` clears it. Events from that browser carry `internal: true`. Richard will set this on his own devices.
   - A config constant `CARD_ACTIONS_EXPERIMENT = { enabled: true, fallback: 'rows' }`. When `enabled` is `false`, everyone gets `fallback` and no experiment metadata is added. This is the kill switch and also how the winner gets shipped.
3. **Render** the action section for the assigned variant, using the existing values for walking minutes, distance and URLs. Walking minutes and distance are static values the app already works out from distance. **Do not add any live routing or Places calls.** Cost per session is already above target.
4. **Tag analytics.** Add these keys to the `metadata` of the existing `venue_card_opened` and `venue_action_clicked` events (Supabase `events` table, plus the GA4 equivalents as event parameters):

   | Key | Type | Example |
   |---|---|---|
   | `exp_id` | text | `"card_actions_v1"` |
   | `exp_variant` | text | `"rows"` / `"button"` |
   | `exp_forced` | bool | `false` |
   | `exp_sticky` | bool | `true` |
   | `internal` | bool | `false` |
   | `near` | bool | `true` when the card is in close-by mode |

   On `venue_action_clicked` also add `slot`, saying which element was tapped: `row_primary`, `row_secondary`, `button_primary` or `text_link`. Keep the existing keys (`action`, `primary`, `distance_m`, `distance_km`, `venue_id`, `venue_name`, `provider`). Set `primary` to whether the tapped action was the highlighted one or the button.
5. **New event `trip_line_tapped`.** Log it when someone taps the flat trip line, with the same experiment metadata plus `venue_id`. The line does nothing when tapped. This event tells us whether people mistake it for a button.
6. **Accessibility.** Use real `<a href>` elements, minimum 44px tap targets, and decorative SVGs with `aria-hidden="true"`. The trip line gets an `aria-label` (e.g. "Trip: 9 min walk") and **no** `role="button"`. White text only goes on the `#EA6A0A` orange at 18px bold or larger.
7. **Don't touch anything else on the card**: title, photo, weather chips, heart and close buttons.

## 4. QA checklist (on sunny-dev first)

- [ ] Both variants render in close-by and further-away modes and match `reference.html` at 360px, 390px and 430px widths
- [ ] All four action links open the same destinations as before the change (check on iOS Safari and Android Chrome)
- [ ] The variant stays the same after a reload and in a new tab. Clearing storage re-randomises it
- [ ] `?card_actions=` and `?internal=` work and show up in event metadata
- [ ] Every `venue_card_opened`, `venue_action_clicked` and `trip_line_tapped` row in sunny-dev's `events` table has the new keys
- [ ] Setting `enabled: false` shows only the fallback, with no `exp_*` keys
- [ ] No new network requests per card open (check the Network tab)
- [ ] No console errors when localStorage is blocked (private mode)

Deploy to production only once all of that passes. Record the exact go-live timestamp (UTC) in a comment at the top of `analysis.sql`.

## 5. Measuring it

Supabase is the source of truth. The queries are in `analysis.sql`. Always exclude `internal = true` and `exp_forced = true`.

- **Primary metric:** the share of card-opening sessions in each variant that tapped any action (Directions or Uber).
- **Secondary metrics:**
  - action taps per card open
  - Directions rate and Uber rate separately
  - all of the above split by close-by vs further away
  - `trip_line_tapped` per card open (a high rate means confusion)
  - which slot gets tapped (in `rows`, does row 2 get used? In `button`, does the text link?)

## 6. When to stop, and how to decide

**Be realistic about the numbers.** At current traffic, roughly 275 card-opening sessions per variant per month, a month only reliably detects a **big** difference, around a doubling (e.g. 5% → 11%). Summer traffic should help.

- Run for **at least 28 days** and until each variant has **at least 400 card-opening sessions**, whichever comes later. Don't stop early because one variant looks ahead after a week.
- **Clear winner** (|z| ≥ 1.96 on the primary metric in `analysis.sql`): ship it.
- **No clear winner:** look at the secondary metrics. If one variant leads on the primary metric and the trip-line tap rate is fine, ship it. If it's genuinely even, ship `button` because it's simpler and shorter.
- **To ship:** set `enabled: false` with `fallback` set to the winner. A week later, remove the losing variant's code and the experiment scaffolding.

## 7. Out of scope

Live routing or ETA calculation, the native app, any change to the close-by threshold, and new tracking tables (use `events.metadata` only, which keeps us on the free plan).
