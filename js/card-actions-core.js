/*
  Sunny — card-actions-core.js
  Experiment card_actions_v1: variant assignment, analytics metadata and the
  HTML for the venue card's action section (trip line + Directions/Uber).
  Two variants, "rows" and "button", each in three modes:
    near  – close by (Directions is the recommended action)
    far   – further away (Uber is the recommended action)
    none  – no location shared (no trip line)
  The close-by rule, walk minutes, distance and URLs all come from the caller
  (js/venue-cta-core.js and app.js); nothing here changes them. No network calls.
  Loads as a classic <script> (exposes window.SunnyCardActions) and via
  require() in Node for the tests.

  Kill switch / shipping the winner: set CARD_ACTIONS_EXPERIMENT.enabled = false
  and fallback = the winning variant. Everyone then sees the fallback and no
  experiment metadata is added to events.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnyCardActions = api;
})(typeof self !== "undefined" ? self : this, function () {
  const CARD_ACTIONS_EXPERIMENT = { enabled: true, fallback: "rows" };

  const EXP_ID = "card_actions_v1";
  const STORE_KEY = "sunny_exp_card_actions_v1";
  const FORCED_KEY = "sunny_exp_card_actions_v1_forced";
  const INTERNAL_KEY = "sunny_internal";
  const VARIANTS = ["rows", "button"];
  const MODES = ["near", "far", "none"];

  // ---------- Assignment ----------

  function defaultStorage() {
    try { return typeof window !== "undefined" ? window.localStorage : null; } catch (e) { return null; }
  }
  function defaultSearch() {
    try { return typeof window !== "undefined" ? window.location.search : ""; } catch (e) { return ""; }
  }
  function defaultRandom() {
    try {
      const a = new Uint8Array(1);
      (typeof window !== "undefined" ? window : globalThis).crypto.getRandomValues(a);
      return a[0] & 1;
    } catch (e) {
      return Math.random() < 0.5 ? 0 : 1;
    }
  }

  function storeGet(s, k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function storeSet(s, k, v) { try { if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
  function storeDel(s, k) { try { if (s) s.removeItem(k); } catch (e) { /* ignore */ } }

  /**
   * Work out this browser's assignment. Pure apart from the storage it is given.
   * env = { storage, search, random, config } – all optional (browser defaults).
   * Returns { variant, forced, sticky, internal, active }.
   */
  function computeAssignment(env) {
    env = env || {};
    const storage = "storage" in env ? env.storage : defaultStorage();
    const search = "search" in env ? env.search : defaultSearch();
    const random = env.random || defaultRandom;
    const config = env.config || CARD_ACTIONS_EXPERIMENT;

    let params = null;
    try { params = new URLSearchParams(search || ""); } catch (e) { params = null; }

    // Internal-traffic flag: ?internal=1 sets it, ?internal=0 clears it.
    if (params && params.has("internal")) {
      if (params.get("internal") === "1") storeSet(storage, INTERNAL_KEY, "1");
      else storeDel(storage, INTERNAL_KEY);
    }
    const internal = storeGet(storage, INTERNAL_KEY) === "1";

    if (!config.enabled) {
      const fb = VARIANTS.indexOf(config.fallback) !== -1 ? config.fallback : VARIANTS[0];
      return { variant: fb, forced: false, sticky: true, internal, active: false };
    }

    // QA override: ?card_actions=rows|button forces and stores the variant.
    const override = params && params.get("card_actions");
    let forcedNow = false;
    let variant = null;
    let sticky = true;
    if (override && VARIANTS.indexOf(override) !== -1) {
      variant = override;
      forcedNow = true;
      const ok = storeSet(storage, STORE_KEY, override);
      storeSet(storage, FORCED_KEY, "1");
      sticky = ok;
    } else {
      variant = storeGet(storage, STORE_KEY);
    }

    if (VARIANTS.indexOf(variant) === -1) {
      variant = VARIANTS[random() ? 1 : 0];
      sticky = storeSet(storage, STORE_KEY, variant);
      storeDel(storage, FORCED_KEY);
    }
    const forced = forcedNow || storeGet(storage, FORCED_KEY) === "1";

    return { variant, forced, sticky, internal, active: true };
  }

  let cached = null;
  /** Assignment for this page view – computed on first use (first card render), then reused. */
  function getAssignment() {
    if (!cached) cached = computeAssignment();
    return cached;
  }
  function resetForTests() { cached = null; }

  function nearValue(mode) {
    if (mode === "near") return true;
    if (mode === "far") return false;
    return null;
  }

  /** Metadata for venue_card_opened / venue_action_clicked / trip_line_tapped. {} when disabled. */
  function expMeta(mode, assignment) {
    const a = assignment || getAssignment();
    if (!a.active) return {};
    return {
      exp_id: EXP_ID,
      exp_variant: a.variant,
      exp_forced: !!a.forced,
      exp_sticky: !!a.sticky,
      internal: !!a.internal,
      near: nearValue(mode),
    };
  }

  // Close-by / further-away / no-location, from js/venue-cta-core.js's `primary`.
  function modeFromCta(cta) {
    const p = cta && cta.primary;
    if (p === "directions") return "near";
    if (p === "uber") return "far";
    return "none";
  }

  // ---------- Rendering ----------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Decorative icons (stroke = currentColor).
  function svg(body, size) {
    return '<svg aria-hidden="true" focusable="false" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
  }
  const I = {
    walk: '<circle cx="13.5" cy="4.5" r="1.8"/><path d="M9.5 21l2.5-6"/><path d="M15 21l-1.2-4.6-2.3-2.4 1-5.2-3.2 1.6-1.4 3.6"/><path d="M12.5 9.5l1.8 2.8 3.2 1"/>',
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  };

  // Category label shown at the venue end of the trip line; "Other"/empty → pin only.
  function placeLabelText(label) {
    const s = String(label == null ? "" : label).trim();
    if (!s || s.toLowerCase() === "other") return "";
    return s;
  }

  function tripText(mode, walkMin, distanceKm) {
    return mode === "near" ? "~" + walkMin + " min walk" : "~" + distanceKm + " km away";
  }

  function renderTrip(mode, walkMin, distanceKm, placeLabel) {
    const text = tripText(mode, walkMin, distanceKm);
    const mid = mode === "near"
      ? svg(I.walk, 16) + "<span>" + esc(text) + "</span>"
      : "<span>" + esc(text) + "</span>";
    const label = placeLabelText(placeLabel);
    return (
      '<div class="sca-trip" data-sca-trip aria-label="Trip: ' + esc(text) + '">' +
        '<span class="sca-trip__end"><span class="sca-trip__you"></span>You</span>' +
        '<span class="sca-trip__dots"></span>' +
        '<span class="sca-trip__mid">' + mid + "</span>" +
        '<span class="sca-trip__dots"></span>' +
        '<span class="sca-trip__end sca-trip__end--place">' + svg(I.pin, 16) +
          (label ? '<span class="sca-trip__place">' + esc(label) + "</span>" : "") +
        "</span>" +
      "</div>"
    );
  }

  function link(href, action, slot, primary, cls, inner) {
    return '<a class="' + cls + '" href="' + esc(href) + '" target="_blank" rel="noopener"' +
      ' data-sca-action="' + action + '" data-sca-slot="' + slot + '" data-sca-primary="' + (primary ? "1" : "0") + '">' +
      inner + "</a>";
  }

  function row(o, slot, highlighted, href) {
    const cls = "sca-row" + (highlighted ? " sca-row--primary" : "");
    const inner =
      '<span class="sca-row__icon">' + svg(o.icon, 22) + "</span>" +
      '<span class="sca-row__text"><span class="sca-row__title">' + o.title + "</span>" +
      '<span class="sca-row__sub">' + o.sub + "</span></span>" +
      '<span class="sca-row__trail">' + svg(o.trail, 20) + "</span>";
    return link(href, o.action, slot, highlighted, cls, inner);
  }

  const ROWS = {
    walk: { action: "directions", icon: I.walk, title: "Walking directions", sub: "Step-by-step in Google Maps", trail: I.chev },
    dirFar: { action: "directions", icon: I.pin, title: "Directions", sub: "Drive or transit in Google Maps", trail: I.chev },
    dirNone: { action: "directions", icon: I.pin, title: "Directions", sub: "Open in Google Maps", trail: I.chev },
    uber: { action: "uber", icon: I.car, title: "Uber", sub: "Book a ride in the Uber app", trail: I.ext },
  };

  /**
   * opts = { variant, mode: "near"|"far"|"none", walkMin, distanceKm, placeLabel,
   *          directionsUrl, uberUrl }
   * Every link opens in a new tab (target="_blank" rel="noopener"), as before.
   */
  function render(opts) {
    opts = opts || {};
    const v = VARIANTS.indexOf(opts.variant) !== -1 ? opts.variant : getAssignment().variant;
    const mode = MODES.indexOf(opts.mode) !== -1 ? opts.mode : "none";
    const dir = opts.directionsUrl || "";
    const uber = opts.uberUrl || "";

    const trip = mode === "none" ? "" : renderTrip(mode, opts.walkMin, opts.distanceKm, opts.placeLabel);

    let body;
    if (v === "rows") {
      let rows;
      if (mode === "near") rows = row(ROWS.walk, "row_primary", true, dir) + row(ROWS.uber, "row_secondary", false, uber);
      else if (mode === "far") rows = row(ROWS.uber, "row_primary", true, uber) + row(ROWS.dirFar, "row_secondary", false, dir);
      else rows = row(ROWS.dirNone, "row_primary", false, dir) + row(ROWS.uber, "row_secondary", false, uber);
      body = '<div class="sca-rows">' + rows + "</div>";
    } else {
      let btn;
      let alt;
      if (mode === "far") {
        btn = link(uber, "uber", "button_primary", true, "sca-btn",
          svg(I.car, 24) + "<span>Book an Uber</span>" + svg(I.ext, 18));
        alt = "Driving yourself? " + link(dir, "directions", "text_link", false, "sca-alt__link", "Get directions");
      } else {
        btn = link(dir, "directions", "button_primary", true, "sca-btn",
          svg(I.nav, 20) + "<span>Directions in Google Maps</span>");
        alt = mode === "near"
          ? "Rather not walk? " + link(uber, "uber", "text_link", false, "sca-alt__link", "Book an Uber")
          : "or " + link(uber, "uber", "text_link", false, "sca-alt__link", "book an Uber");
      }
      body = '<div class="sca-button-group">' + btn + '<p class="sca-alt">' + alt + "</p></div>";
    }

    return '<div class="sca" data-sca-variant="' + v + '" data-sca-mode="' + mode + '">' + trip + body + "</div>";
  }

  return {
    CARD_ACTIONS_EXPERIMENT,
    EXP_ID,
    STORE_KEY,
    FORCED_KEY,
    INTERNAL_KEY,
    VARIANTS,
    computeAssignment,
    getAssignment,
    expMeta,
    modeFromCta,
    render,
    _resetForTests: resetForTests,
  };
});
