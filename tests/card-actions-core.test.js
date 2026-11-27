// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/card-actions-core.js");

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
const throwingStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};
const ON = { enabled: true, fallback: "rows" };

// ---------- Assignment ----------

test("first visit: random 50/50 assignment is stored and sticky", () => {
  const s = memStorage();
  const a = C.computeAssignment({ storage: s, search: "", random: () => 1, config: ON });
  assert.equal(a.variant, "button");
  assert.equal(a.sticky, true);
  assert.equal(a.forced, false);
  assert.equal(a.active, true);
  assert.equal(s.getItem(C.STORE_KEY), "button");
  const b = C.computeAssignment({ storage: s, search: "", random: () => 0, config: ON });
  assert.equal(b.variant, "button", "returning visitor keeps the stored variant");
  const c = C.computeAssignment({ storage: memStorage(), search: "", random: () => 0, config: ON });
  assert.equal(c.variant, "rows");
});

test("cleared storage re-randomises", () => {
  const s = memStorage({ [C.STORE_KEY]: "rows" });
  s.removeItem(C.STORE_KEY);
  assert.equal(C.computeAssignment({ storage: s, search: "", random: () => 1, config: ON }).variant, "button");
});

test("an unknown stored value is replaced", () => {
  const s = memStorage({ [C.STORE_KEY]: "banana" });
  const a = C.computeAssignment({ storage: s, search: "", random: () => 0, config: ON });
  assert.equal(a.variant, "rows");
  assert.equal(s.getItem(C.STORE_KEY), "rows");
});

test("?card_actions= forces, stores and marks the browser forced", () => {
  const s = memStorage({ [C.STORE_KEY]: "rows" });
  const a = C.computeAssignment({ storage: s, search: "?card_actions=button", random: () => 0, config: ON });
  assert.deepEqual([a.variant, a.forced, a.sticky], ["button", true, true]);
  // Later visit without the param: still forced, still button
  const b = C.computeAssignment({ storage: s, search: "", random: () => 0, config: ON });
  assert.deepEqual([b.variant, b.forced], ["button", true]);
  // Invalid override is ignored
  const c = C.computeAssignment({ storage: memStorage(), search: "?card_actions=nope", random: () => 0, config: ON });
  assert.deepEqual([c.variant, c.forced], ["rows", false]);
});

test("?internal=1 sets and ?internal=0 clears the internal flag", () => {
  const s = memStorage();
  assert.equal(C.computeAssignment({ storage: s, search: "?internal=1", config: ON }).internal, true);
  assert.equal(s.getItem(C.INTERNAL_KEY), "1");
  assert.equal(C.computeAssignment({ storage: s, search: "", config: ON }).internal, true);
  assert.equal(C.computeAssignment({ storage: s, search: "?internal=0", config: ON }).internal, false);
  assert.equal(s.getItem(C.INTERNAL_KEY), null);
});

test("storage unavailable: assigns for this page view only, sticky false, no throw", () => {
  for (const storage of [throwingStorage, null]) {
    const a = C.computeAssignment({ storage, search: "?internal=1", random: () => 1, config: ON });
    assert.equal(a.variant, "button");
    assert.equal(a.sticky, false);
    assert.equal(a.internal, false);
    assert.equal(a.active, true);
  }
  const f = C.computeAssignment({ storage: throwingStorage, search: "?card_actions=rows", config: ON });
  assert.deepEqual([f.variant, f.forced, f.sticky], ["rows", true, false]);
});

test("kill switch: everyone gets the fallback and no experiment metadata", () => {
  const s = memStorage({ [C.STORE_KEY]: "button" });
  const a = C.computeAssignment({ storage: s, search: "?card_actions=button", config: { enabled: false, fallback: "button" } });
  assert.equal(a.variant, "button");
  assert.equal(a.active, false);
  const r = C.computeAssignment({ storage: s, search: "?card_actions=button", config: { enabled: false, fallback: "rows" } });
  assert.equal(r.variant, "rows");
  assert.deepEqual(C.expMeta("near", r), {});
});

test("expMeta: all keys, near true/false/null by mode", () => {
  const a = { variant: "rows", forced: false, sticky: true, internal: false, active: true };
  assert.deepEqual(C.expMeta("near", a), {
    exp_id: "card_actions_v1", exp_variant: "rows", exp_forced: false, exp_sticky: true, internal: false, near: true,
  });
  assert.equal(C.expMeta("far", a).near, false);
  assert.equal(C.expMeta("none", a).near, null);
  assert.ok("near" in C.expMeta("none", a));
});

test("modeFromCta follows venue-cta-core's primary (unchanged 2 km rule)", () => {
  const V = require("../js/venue-cta-core.js");
  assert.equal(C.modeFromCta(V.getVenueCta(1.999)), "near");
  assert.equal(C.modeFromCta(V.getVenueCta(2)), "far");
  assert.equal(C.modeFromCta(V.getVenueCta(null)), "none");
  assert.equal(C.modeFromCta(null), "none");
});

test("config defaults: enabled with fallback rows", () => {
  assert.deepEqual(C.CARD_ACTIONS_EXPERIMENT, { enabled: true, fallback: "rows" });
});

// ---------- Rendering ----------

const DIR = "https://www.google.com/maps/dir/?api=1&destination=-33.9%2C151.2";
const UBER = "https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=-33.9&dropoff[longitude]=151.2&dropoff[nickname]=The%20Pub";
const base = { walkMin: 9, distanceKm: 3.1, placeLabel: "Pub/Bar", directionsUrl: DIR, uberUrl: UBER };

function links(html) {
  const out = [];
  const re = /<a ([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; });
    out.push(attrs);
  }
  return out;
}
const unesc = (s) => s.replace(/&amp;/g, "&");

test("every combination: real links, same hrefs, new tab, decorative SVGs", () => {
  for (const variant of ["rows", "button"]) {
    for (const mode of ["near", "far", "none"]) {
      const html = C.render({ ...base, variant, mode });
      const ls = links(html);
      assert.equal(ls.length, 2, `${variant}/${mode} has two links`);
      const byAction = Object.fromEntries(ls.map((l) => [l["data-sca-action"], l]));
      assert.equal(unesc(byAction.directions.href), DIR);
      assert.equal(unesc(byAction.uber.href), UBER);
      for (const l of ls) {
        assert.equal(l.target, "_blank");
        assert.equal(l.rel, "noopener");
      }
      const svgs = html.match(/<svg /g) || [];
      const hidden = html.match(/<svg aria-hidden="true"/g) || [];
      assert.equal(svgs.length, hidden.length, "all SVGs aria-hidden");
      assert.doesNotMatch(html, /role="button"/);
      assert.match(html, new RegExp(`data-sca-variant="${variant}"`));
    }
  }
});

test("slots and primary flags", () => {
  const slots = (variant, mode) =>
    links(C.render({ ...base, variant, mode })).map((l) => `${l["data-sca-action"]}:${l["data-sca-slot"]}:${l["data-sca-primary"]}`);
  assert.deepEqual(slots("rows", "near"), ["directions:row_primary:1", "uber:row_secondary:0"]);
  assert.deepEqual(slots("rows", "far"), ["uber:row_primary:1", "directions:row_secondary:0"]);
  assert.deepEqual(slots("rows", "none"), ["directions:row_primary:0", "uber:row_secondary:0"]);
  assert.deepEqual(slots("button", "near"), ["directions:button_primary:1", "uber:text_link:0"]);
  assert.deepEqual(slots("button", "far"), ["uber:button_primary:1", "directions:text_link:0"]);
  assert.deepEqual(slots("button", "none"), ["directions:button_primary:1", "uber:text_link:0"]);
});

test("copy per variant and mode", () => {
  const rn = C.render({ ...base, variant: "rows", mode: "near" });
  assert.match(rn, /Walking directions/);
  assert.match(rn, /Step-by-step in Google Maps/);
  assert.match(rn, /sca-row sca-row--primary/);
  const rf = C.render({ ...base, variant: "rows", mode: "far" });
  assert.match(rf, /Drive or transit in Google Maps/);
  const r0 = C.render({ ...base, variant: "rows", mode: "none" });
  assert.match(r0, /Open in Google Maps/);
  assert.match(r0, /Book a ride in the Uber app/);
  assert.doesNotMatch(r0, /sca-row--primary/, "no-location rows are equal");
  const bn = C.render({ ...base, variant: "button", mode: "near" });
  assert.match(bn, /Directions in Google Maps/);
  assert.match(bn, /Rather not walk\? <a/);
  const bf = C.render({ ...base, variant: "button", mode: "far" });
  assert.match(bf, /<span>Book an Uber<\/span>/);
  assert.match(bf, /Driving yourself\? <a[^>]*>Get directions<\/a>/);
  const b0 = C.render({ ...base, variant: "button", mode: "none" });
  assert.match(b0, /Directions in Google Maps/);
  assert.match(b0, /or <a[^>]*>book an Uber<\/a>/);
});

test("trip line: ~ estimates, aria-label, no trip line without location", () => {
  const near = C.render({ ...base, variant: "rows", mode: "near" });
  assert.match(near, /data-sca-trip aria-label="Trip: ~9 min walk"/);
  assert.match(near, /<span>~9 min walk<\/span>/);
  const far = C.render({ ...base, variant: "button", mode: "far" });
  assert.match(far, /aria-label="Trip: ~3.1 km away"/);
  for (const variant of ["rows", "button"]) {
    assert.doesNotMatch(C.render({ ...base, variant, mode: "none" }), /sca-trip/);
  }
});

test("trip line end: category label, or pin only for empty / Other", () => {
  const withLabel = C.render({ ...base, variant: "rows", mode: "near", placeLabel: "Club" });
  assert.match(withLabel, /<span class="sca-trip__place">Club<\/span>/);
  assert.doesNotMatch(withLabel, />Pub</);
  for (const placeLabel of ["", "Other", null, undefined, "  "]) {
    const html = C.render({ ...base, variant: "rows", mode: "near", placeLabel });
    assert.doesNotMatch(html, /sca-trip__place/);
    assert.match(html, /sca-trip__end--place"><svg aria-hidden="true"/);
  }
});

test("values are escaped", () => {
  const html = C.render({ ...base, variant: "rows", mode: "near", placeLabel: '<b>"x"</b>', directionsUrl: 'https://x/?a="b"&c=<d>' });
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
  assert.match(html, /href="https:\/\/x\/\?a=&quot;b&quot;&amp;c=&lt;d&gt;"/);
});
