// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../js/qualification-core.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// A venue_details row store plus counters for every Places call and save.
function harness(row, { place = { outdoorSeating: true, servesBeer: true }, rowOnReread } = {}) {
  const calls = { read: 0, fetch: 0, save: 0, saved: [] };
  const enrich = Q.createQualificationEnricher({
    now: () => NOW,
    ttlMs: 30 * DAY,
    readRow: async () => {
      calls.read++;
      if (calls.read > 1 && rowOnReread !== undefined) return rowOnReread;
      return row;
    },
    fetchPlace: async () => { calls.fetch++; return place; },
    saveRow: async (placeId, p, status) => { calls.save++; calls.saved.push(status); },
  });
  return { enrich, calls };
}

for (const status of ["rejected_not_eligible", "rejected_no_outdoor"]) {
  test(`${status} older than 30 days stays rejected after a card open and a background pass, with no Places call`, async () => {
    const row = { qualification_status: status, last_enriched_at: daysAgo(45), fetched_at: daysAgo(45) };
    const { enrich, calls } = harness(row);

    const cardOpen = await enrich("p1", "user_initiated", "venue_card_opened", {});
    const background = await enrich("p1", "background", "medium_confidence_background", { bucket: "medium_confidence" });

    for (const result of [cardOpen, background]) {
      assert.equal(result.qualificationStatus, status);
      assert.equal(result.cacheHit, true); // so background enrichment doesn't spend its budget
      assert.equal(result.locked, true);
    }
    assert.equal(calls.fetch, 0);
    assert.equal(calls.save, 0);
    assert.equal(row.qualification_status, status);
  });
}

test("a rejected_ row with no last_enriched_at is still locked", async () => {
  const { enrich, calls } = harness({ qualification_status: "rejected_not_eligible", last_enriched_at: null });
  const result = await enrich("p1", "targeted", "confirmed_supply_low", {});
  assert.equal(result.qualificationStatus, "rejected_not_eligible");
  assert.equal(calls.fetch, 0);
  assert.equal(calls.save, 0);
});

test("a confirmed row older than 30 days is refreshed from Places once and saved", async () => {
  const { enrich, calls } = harness(
    { qualification_status: "confirmed", last_enriched_at: daysAgo(45) },
    { place: { outdoorSeating: true, servesWine: true } },
  );
  const result = await enrich("p1", "user_initiated", "venue_card_opened", {});
  assert.deepEqual(result, { qualificationStatus: "confirmed", cacheHit: false });
  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.saved, ["confirmed"]);
});

test("a confirmed row within 30 days is a cache hit with no Places call", async () => {
  const { enrich, calls } = harness({ qualification_status: "confirmed", last_enriched_at: daysAgo(5) });
  const result = await enrich("p1", "background", "medium_confidence_background", {});
  assert.deepEqual(result, { qualificationStatus: "confirmed", cacheHit: true });
  assert.equal(calls.fetch, 0);
  assert.equal(calls.save, 0);
});

test("an unknown_after_enrichment row is checked with Places and may be rejected", async () => {
  const { enrich, calls } = harness(
    { qualification_status: "unknown_after_enrichment", last_enriched_at: daysAgo(85) },
    { place: { outdoorSeating: false } },
  );
  const result = await enrich("p1", "user_initiated", "venue_card_opened", {});
  assert.equal(result.qualificationStatus, "rejected_no_outdoor");
  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.saved, ["rejected_no_outdoor"]);
});

test("a rejection that lands while Places is answering is not overwritten", async () => {
  const { enrich, calls } = harness(null, {
    rowOnReread: { qualification_status: "rejected_not_eligible", last_enriched_at: daysAgo(85) },
  });
  const result = await enrich("p1", "user_initiated", "venue_card_opened", {});
  assert.equal(result.qualificationStatus, "rejected_not_eligible");
  assert.equal(result.locked, true);
  assert.equal(result.cacheHit, false); // a Places call was made and billed
  assert.equal(calls.fetch, 1);
  assert.equal(calls.save, 0);
});

test("a failed row read falls through to Places, as before", async () => {
  const calls = { fetch: 0, save: 0 };
  const enrich = Q.createQualificationEnricher({
    now: () => NOW,
    readRow: async () => { throw new Error("network"); },
    fetchPlace: async () => { calls.fetch++; return { outdoorSeating: true, servesCocktails: true }; },
    saveRow: async () => { calls.save++; },
  });
  const result = await enrich("p1", "user_initiated", "venue_card_opened", {});
  assert.equal(result.qualificationStatus, "confirmed");
  assert.equal(calls.fetch, 1);
  assert.equal(calls.save, 1);
});

test("a Places failure resolves to null and saves nothing", async () => {
  let saves = 0;
  const enrich = Q.createQualificationEnricher({
    readRow: async () => null,
    fetchPlace: async () => { throw new Error("quota"); },
    saveRow: async () => { saves++; },
  });
  assert.equal(await enrich("p1", "background", "x", {}), null);
  assert.equal(saves, 0);
});

test("isEditoriallyLocked covers every rejected_ status only", () => {
  assert.equal(Q.isEditoriallyLocked("rejected_not_eligible"), true);
  assert.equal(Q.isEditoriallyLocked("rejected_no_alcohol"), true);
  assert.equal(Q.isEditoriallyLocked("confirmed"), false);
  assert.equal(Q.isEditoriallyLocked("unknown_after_enrichment"), false);
  assert.equal(Q.isEditoriallyLocked(null), false);
});

test("qualifyFromPlace matches the previous app.js rules", () => {
  assert.equal(Q.qualifyFromPlace({ outdoorSeating: true, servesBeer: true }), "confirmed");
  assert.equal(Q.qualifyFromPlace({ outdoorSeating: false, servesBeer: true }), "rejected_no_outdoor");
  assert.equal(Q.qualifyFromPlace({ outdoorSeating: true, servesBeer: false }), "rejected_no_alcohol");
  assert.equal(Q.qualifyFromPlace({ servesWine: false, servesBeer: false }), "rejected_no_alcohol");
  assert.equal(Q.qualifyFromPlace({ outdoorSeating: true }), "unknown_after_enrichment");
  assert.equal(Q.qualifyFromPlace({}), "unknown_after_enrichment");
  assert.equal(Q.qualifyFromPlace(null), "unknown_after_enrichment");
});
