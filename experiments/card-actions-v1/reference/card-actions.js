/* Sunny – venue card actions experiment (card_actions_v1)
 * Reference implementation in plain JS. Adapt to the app's own module/render/tracking patterns.
 * Exposes window.SunnyCardActions = { getAssignment, render, expMeta, bind }.
 */
(function () {
  'use strict';

  var CARD_ACTIONS_EXPERIMENT = { enabled: true, fallback: 'rows' };

  var EXP_ID = 'card_actions_v1';
  var STORE_KEY = 'sunny_exp_card_actions_v1';
  var FORCED_KEY = 'sunny_exp_card_actions_v1_forced';
  var INTERNAL_KEY = 'sunny_internal';
  var VARIANTS = ['rows', 'button'];

  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function storeDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function random5050() {
    try {
      var a = new Uint8Array(1);
      window.crypto.getRandomValues(a);
      return VARIANTS[a[0] & 1];
    } catch (e) {
      return VARIANTS[Math.random() < 0.5 ? 0 : 1];
    }
  }

  var cached = null;

  /** Returns { variant, forced, sticky, internal, active } – computed once per page load. */
  function getAssignment() {
    if (cached) return cached;

    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }

    // Internal-traffic flag (?internal=1 / ?internal=0)
    if (params && params.has('internal')) {
      if (params.get('internal') === '1') storeSet(INTERNAL_KEY, '1'); else storeDel(INTERNAL_KEY);
    }
    var internal = storeGet(INTERNAL_KEY) === '1';

    if (!CARD_ACTIONS_EXPERIMENT.enabled) {
      cached = { variant: CARD_ACTIONS_EXPERIMENT.fallback, forced: false, sticky: true, internal: internal, active: false };
      return cached;
    }

    // QA override (?card_actions=rows|button)
    var override = params && params.get('card_actions');
    if (override && VARIANTS.indexOf(override) !== -1) {
      storeSet(STORE_KEY, override);
      storeSet(FORCED_KEY, '1');
    }

    var variant = storeGet(STORE_KEY);
    var sticky = true;
    if (VARIANTS.indexOf(variant) === -1) {
      variant = random5050();
      sticky = storeSet(STORE_KEY, variant);
      storeDel(FORCED_KEY);
    }
    var forced = storeGet(FORCED_KEY) === '1';

    cached = { variant: variant, forced: forced, sticky: sticky, internal: internal, active: true };
    return cached;
  }

  /** Metadata to merge into venue_card_opened / venue_action_clicked / trip_line_tapped. */
  function expMeta(isNear) {
    var a = getAssignment();
    if (!a.active) return {};
    return {
      exp_id: EXP_ID,
      exp_variant: a.variant,
      exp_forced: a.forced,
      exp_sticky: a.sticky,
      internal: a.internal,
      near: !!isNear
    };
  }

  // ---------- Icons (decorative, stroke = currentColor) ----------
  function svg(body, size) {
    return '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }
  var I = {
    walk: '<circle cx="13.5" cy="4.5" r="1.8"/><path d="M9.5 21l2.5-6"/><path d="M15 21l-1.2-4.6-2.3-2.4 1-5.2-3.2 1.6-1.4 3.6"/><path d="M12.5 9.5l1.8 2.8 3.2 1"/>',
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Render the action section.
   * opts = {
   *   variant: 'rows' | 'button'   (default: getAssignment().variant)
   *   isNear: boolean              (existing close-by rule – do not change it)
   *   walkMins: number             (existing static estimate)
   *   distanceKm: number           (existing value, 1 decimal)
   *   directionsUrl: string        (existing Google Maps URL)
   *   uberUrl: string              (existing Uber deep link / URL)
   *   linkAttrs: string            (existing target/rel attributes, e.g. 'target="_blank" rel="noopener"')
   * }
   */
  function render(opts) {
    var v = opts.variant || getAssignment().variant;
    var near = !!opts.isNear;
    var la = opts.linkAttrs ? ' ' + opts.linkAttrs : '';
    var dir = esc(opts.directionsUrl);
    var uber = esc(opts.uberUrl);

    var mid = near
      ? svg(I.walk, 16) + '<span>' + esc(opts.walkMins) + ' min walk</span>'
      : '<span>' + esc(opts.distanceKm) + ' km away</span>';
    var trip =
      '<div class="sca-trip" data-sca-trip aria-label="Trip: ' + (near ? esc(opts.walkMins) + ' min walk' : esc(opts.distanceKm) + ' km away') + '">' +
        '<span class="sca-trip__end"><span class="sca-trip__you"></span>You</span>' +
        '<span class="sca-trip__dots"></span>' +
        '<span class="sca-trip__mid">' + mid + '</span>' +
        '<span class="sca-trip__dots"></span>' +
        '<span class="sca-trip__end" style="color:#EA6A0A">' + svg(I.pin, 16) + '<span style="color:#5F6368">Pub</span></span>' +
      '</div>';

    var body;
    if (v === 'rows') {
      var row = function (o) {
        return '<a class="sca-row' + (o.primary ? ' sca-row--primary' : '') + '" href="' + o.href + '"' + la +
          ' data-sca-action="' + o.action + '" data-sca-slot="' + (o.primary ? 'row_primary' : 'row_secondary') + '"' +
          ' data-sca-primary="' + (o.primary ? '1' : '0') + '">' +
          '<span class="sca-row__icon">' + svg(o.icon, 22) + '</span>' +
          '<span class="sca-row__text"><span class="sca-row__title">' + o.title + '</span>' +
          '<span class="sca-row__sub">' + o.sub + '</span></span>' +
          '<span class="sca-row__trail">' + svg(o.trail, 20) + '</span></a>';
      };
      var walkRow = { action: 'directions', href: dir, icon: I.walk, title: 'Walking directions', sub: 'Step-by-step in Google Maps', trail: I.chev };
      var dirRow = { action: 'directions', href: dir, icon: I.pin, title: 'Directions', sub: 'Drive or transit in Google Maps', trail: I.chev };
      var uberRow = { action: 'uber', href: uber, icon: I.car, title: 'Uber', sub: 'Book a ride in the Uber app', trail: I.ext };
      body = '<div class="sca-rows">' +
        (near
          ? row(Object.assign({ primary: true }, walkRow)) + row(Object.assign({ primary: false }, uberRow))
          : row(Object.assign({ primary: true }, uberRow)) + row(Object.assign({ primary: false }, dirRow))) +
        '</div>';
    } else {
      body = '<div class="sca-button-group">' +
        (near
          ? '<a class="sca-btn" href="' + dir + '"' + la + ' data-sca-action="directions" data-sca-slot="button_primary" data-sca-primary="1">' +
              svg(I.nav, 20) + '<span>Directions in Google Maps</span></a>' +
            '<p class="sca-alt">Rather not walk? <a href="' + uber + '"' + la + ' data-sca-action="uber" data-sca-slot="text_link" data-sca-primary="0">Book an Uber</a></p>'
          : '<a class="sca-btn" href="' + uber + '"' + la + ' data-sca-action="uber" data-sca-slot="button_primary" data-sca-primary="1">' +
              svg(I.car, 24) + '<span>Book an Uber</span>' + svg(I.ext, 18) + '</a>' +
            '<p class="sca-alt">Driving yourself? <a href="' + dir + '"' + la + ' data-sca-action="directions" data-sca-slot="text_link" data-sca-primary="0">Get directions</a></p>') +
        '</div>';
    }

    return '<div class="sca" data-sca-variant="' + v + '" data-sca-near="' + (near ? '1' : '0') + '">' + trip + body + '</div>';
  }

  /**
   * Wire analytics on a rendered section. `track(eventType, metadata)` is the app's existing tracker
   * (Supabase events + GA4). `base` holds the existing keys (venue_id, venue_name, provider, distance_m, distance_km).
   * If the app already tracks clicks elsewhere, merge these keys into that call instead of double-logging.
   */
  function bind(rootEl, track, base) {
    var sec = rootEl.querySelector('.sca');
    if (!sec) return;
    var near = sec.getAttribute('data-sca-near') === '1';
    var shown = sec.getAttribute('data-sca-variant');
    // Always report the variant actually rendered
    var meta = function () { var m = expMeta(near); if (m.exp_id) m.exp_variant = shown; return m; };

    sec.addEventListener('click', function (e) {
      var a = e.target.closest('[data-sca-action]');
      if (a) {
        track('venue_action_clicked', Object.assign({}, base, meta(), {
          action: a.getAttribute('data-sca-action'),
          primary: a.getAttribute('data-sca-primary') === '1',
          slot: a.getAttribute('data-sca-slot')
        }));
        return;
      }
      if (e.target.closest('[data-sca-trip]')) {
        track('trip_line_tapped', Object.assign({ venue_id: base && base.venue_id }, meta()));
      }
    });
  }

  window.SunnyCardActions = { getAssignment: getAssignment, render: render, expMeta: expMeta, bind: bind, config: CARD_ACTIONS_EXPERIMENT };
})();
