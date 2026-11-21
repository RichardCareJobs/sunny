// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../js/tile-core.js");

// A 0.05° cell centre near Newcastle NSW, so small offsets stay inside the cell.
const NEWCASTLE = { lat: -32.95, lng: 151.80 };
const DAY = 24 * 60 * 60 * 1000;

// Move a point by metres north/east (small-distance approximation, good enough for tests).
function offset(point, northM, eastM) {
  const dLat = northM / 111320;
  const dLng = eastM / (111320 * Math.cos(point.lat * Math.PI / 180));
  return { lat: point.lat + dLat, lng: point.lng + dLng };
}

function entry(center, coverRadiusM, extra = {}) {
  return {
    key: T.cellKey(center.lat, center.lng, extra.filterHash || "f"),
    lat: center.lat,
    lng: center.lng,
    coverRadiusM,
    filterHash: "f",
    ts: extra.ts ?? 1_000_000,
    venues: [],
    ...extra,
  };
}

test("distanceM is roughly right", () => {
  const p = offset(NEWCASTLE, 1000, 0);
  assert.ok(Math.abs(T.distanceM(NEWCASTLE.lat, NEWCASTLE.lng, p.lat, p.lng) - 1000) < 5);
  assert.equal(T.distanceM(1, 2, 1, 2), 0);
});

test("cellKey snaps to the 0.05° grid and includes the filter hash", () => {
  assert.equal(T.cellKey(-32.9267, 151.7789, "outdoor:1"), "-32.950:151.800:outdoor:1");
  assert.equal(T.cellKey(-32.9267, 151.7789, "a"), T.cellKey(-32.94, 151.79, "a"));
  assert.notEqual(T.cellKey(-32.9267, 151.7789, "a"), T.cellKey(-32.9267, 151.7789, "b"));
  assert.equal(T.cellKey(NaN, 1, "a"), "");
  assert.equal(T.cellKey(0.0000001, -0.0000001, ""), "0.000:0.000:");
});

test("coverRadiusM: unsaturated search covers the full radius", () => {
  assert.equal(T.coverRadiusM([100, 200, 3000]), T.SEARCH_RADIUS_M);
  assert.equal(T.coverRadiusM([]), T.SEARCH_RADIUS_M);
  assert.equal(T.coverRadiusM(null), T.SEARCH_RADIUS_M);
});

test("coverRadiusM: saturated search covers out to the farthest result", () => {
  const distances = Array.from({ length: 20 }, (_, i) => 50 * (i + 1)); // 50..1000 m
  assert.equal(T.coverRadiusM(distances), 1000);
  assert.equal(T.coverRadiusM(distances, { searchRadiusM: 800 }), 800);
});

test("findCoveringEntry: same cell is always a hit (previous behaviour)", () => {
  const e = entry(NEWCASTLE, 500);
  const nearby = offset(NEWCASTLE, 900, 900); // still in the same 0.05° cell, outside 500 m
  const view = { ...nearby, radiusM: 2000, filterHash: "f" };
  assert.equal(T.cellKey(nearby.lat, nearby.lng, "f"), e.key);
  assert.equal(T.findCoveringEntry([e], view, { now: 1_000_000 }), e);
});

test("findCoveringEntry: neighbouring cell inside an unsaturated search is covered", () => {
  const e = entry(NEWCASTLE, 12000);
  const moved = offset(NEWCASTLE, 0, 4000); // crosses into the next cell east
  assert.notEqual(T.cellKey(moved.lat, moved.lng, "f"), e.key);
  const view = { ...moved, radiusM: 1500, filterHash: "f" };
  assert.equal(T.findCoveringEntry([e], view, { now: 1_000_000 }), e);
});

test("findCoveringEntry: dense area (small cover radius) needs a new search", () => {
  const e = entry(NEWCASTLE, 600);
  const moved = offset(NEWCASTLE, 0, 4000);
  const view = { ...moved, radiusM: 700, filterHash: "f" };
  assert.equal(T.findCoveringEntry([e], view, { now: 1_000_000 }), null);
});

test("findCoveringEntry: a wide zoomed-out view isn't covered by a small search", () => {
  const e = entry(NEWCASTLE, 12000);
  const moved = offset(NEWCASTLE, 0, 4000);
  const view = { ...moved, radiusM: 30000, filterHash: "f" };
  assert.equal(T.findCoveringEntry([e], view, { now: 1_000_000 }), null);
});

test("findCoveringEntry ignores stale entries and other filters", () => {
  const e = entry(NEWCASTLE, 12000, { ts: 0 });
  const view = { ...NEWCASTLE, radiusM: 100, filterHash: "f" };
  assert.equal(T.findCoveringEntry([e], view, { now: 8 * DAY }), null);
  assert.equal(T.findCoveringEntry([e], view, { now: 6 * DAY }), e);
  assert.equal(T.findCoveringEntry([e], { ...view, filterHash: "other" }, { now: 6 * DAY }), null);
});

test("findCoveringEntry accepts a Map and prefers the entry with most slack", () => {
  const far = entry(offset(NEWCASTLE, 0, 9000), 12000, { key: "far" });
  const near = entry(offset(NEWCASTLE, 0, 3000), 12000, { key: "near" });
  const view = { ...offset(NEWCASTLE, 0, -4000), radiusM: 500, filterHash: "f" };
  const map = new Map([["far", far], ["near", near]]);
  assert.equal(T.findCoveringEntry(map, view, { now: 1_000_000 }).key, "near");
});

test("shouldSearchAtZoom gates zoomed-out views", () => {
  assert.equal(T.shouldSearchAtZoom(10), false);
  assert.equal(T.shouldSearchAtZoom(11), true);
  assert.equal(T.shouldSearchAtZoom(15), true);
  assert.equal(T.shouldSearchAtZoom(undefined), true);
});

test("pruneEntries keeps fresh entries, newest first, capped", () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, ts: i * 1000 }));
  list.push({ key: "old", ts: -10 * DAY }, null, { ts: 5 });
  const out = T.pruneEntries(list, { now: 5000, maxEntries: 3 });
  assert.deepEqual(out.map(e => e.key), ["k4", "k3", "k2"]);
});

test("viewRadiusM is half the viewport diagonal", () => {
  const ne = offset(NEWCASTLE, 3000, 4000);
  assert.ok(Math.abs(T.viewRadiusM(NEWCASTLE, ne) - 5000) < 20);
  assert.equal(T.viewRadiusM(null, ne), 0);
});

test("createCallBudget enforces rolling windows and persists", () => {
  let clock = 0;
  let saved = null;
  const budget = T.createCallBudget({
    limits: [{ windowMs: 1000, max: 5 }, { windowMs: 10000, max: 8 }],
    save: s => { saved = s.slice(); },
    now: () => clock,
  });
  assert.equal(budget.canSpend(5), true);
  budget.spend(5);
  assert.equal(budget.canSpend(1), false, "short window full");
  clock = 1500;
  assert.equal(budget.canSpend(3), true);
  budget.spend(3);
  assert.equal(budget.canSpend(1), false, "long window full");
  clock = 10600;
  assert.equal(budget.canSpend(5), true, "everything aged out");
  assert.equal(saved.length, 8);

  const restored = T.createCallBudget({
    limits: [{ windowMs: 1000, max: 5 }, { windowMs: 10000, max: 8 }],
    load: () => saved,
    now: () => 1600,
  });
  assert.equal(restored.canSpend(1), false, "restored stamps count");
  assert.equal(restored.used(1000), 3);
});

test("createCallBudget survives broken storage", () => {
  const budget = T.createCallBudget({ load: () => { throw new Error("blocked"); }, save: () => { throw new Error("full"); } });
  assert.equal(budget.canSpend(4), true);
  budget.spend(4);
  assert.equal(budget.used(), 4);
});
