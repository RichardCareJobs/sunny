// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/venue-cta-core.js");

test("no location: no line, no main button, null distance", () => {
  for (const km of [null, undefined, NaN, Infinity, -1, "2"]) {
    const cta = C.getVenueCta(km);
    assert.equal(cta.mode, "none");
    assert.equal(cta.line, null);
    assert.equal(cta.primary, null);
    assert.equal(cta.distanceKm, null);
  }
});

test("walk time never shows 0 minutes", () => {
  const cta = C.getVenueCta(0.02);
  assert.equal(cta.line, "~1 min walk");
  assert.equal(cta.walkMin, 1);
  assert.equal(C.getVenueCta(0).line, "~1 min walk");
});

test("under 2 km: walk line, Directions is main", () => {
  const cta = C.getVenueCta(1.5); // 1.5 × 1.3 ÷ 5 × 60 = 23.4
  assert.equal(cta.mode, "walk");
  assert.equal(cta.line, "~23 min walk");
  assert.equal(cta.primary, "directions");
  assert.equal(cta.walkMin, 23);
  assert.equal(cta.distanceKm, 1.5);
  assert.equal(C.getVenueCta(1.999).primary, "directions");
});

test("2 km to under 3 km: walk line, Uber is main", () => {
  const at2 = C.getVenueCta(2.0); // 31.2
  assert.equal(at2.line, "~31 min walk");
  assert.equal(at2.primary, "uber");
  const at25 = C.getVenueCta(2.5); // 39
  assert.equal(at25.line, "~39 min walk");
  assert.equal(at25.primary, "uber");
  const justUnder3 = C.getVenueCta(2.999);
  assert.equal(justUnder3.mode, "walk");
  assert.equal(justUnder3.primary, "uber");
  assert.equal(justUnder3.distanceKm, 3);
});

test("3 km and over: drive line, Uber is main", () => {
  const at3 = C.getVenueCta(3.0);
  assert.equal(at3.mode, "drive");
  assert.equal(at3.line, "~3.9 km drive");
  assert.equal(at3.primary, "uber");
  const at34 = C.getVenueCta(3.4);
  assert.equal(at34.line, "~4.4 km drive");
  assert.equal(at34.distanceKm, 3.4);
});

test("distance_km rounds the straight-line km to 1 decimal", () => {
  assert.equal(C.getVenueCta(1.26).distanceKm, 1.3);
  assert.equal(C.getVenueCta(0.04).distanceKm, 0);
  assert.equal(C.getVenueCta(12.345).distanceKm, 12.3);
});
