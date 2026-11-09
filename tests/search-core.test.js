// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/search-core.js");

const pred = (placeId, main, types, secondary = "") => ({
  placePrediction: {
    placeId,
    types,
    structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } },
  },
});

test("normaliseQuery trims, lowercases and collapses whitespace", () => {
  assert.equal(S.normaliseQuery("  Rath   MINES "), "rath mines");
  assert.equal(S.normaliseQuery(null), "");
});

test("classifyPrediction: geographic areas", () => {
  assert.equal(S.classifyPrediction(["sublocality_level_1", "sublocality", "political", "geocode"]), "geo");
  assert.equal(S.classifyPrediction(["locality", "political", "geocode"]), "geo");
  assert.equal(S.classifyPrediction(["postal_town", "geocode"]), "geo");
  assert.equal(S.classifyPrediction(["neighborhood", "political"]), "geo");
});

test("classifyPrediction: food and drink venues", () => {
  assert.equal(S.classifyPrediction(["pub", "bar", "establishment", "point_of_interest"]), "venue");
  assert.equal(S.classifyPrediction(["italian_restaurant", "food", "establishment"]), "venue");
  assert.equal(S.classifyPrediction(["cafe", "store", "establishment"]), "venue");
  assert.equal(S.classifyPrediction(["beer_garden"]), "venue");
});

test("classifyPrediction: drops addresses, countries and unrelated businesses", () => {
  assert.equal(S.classifyPrediction(["street_address", "geocode"]), null);
  assert.equal(S.classifyPrediction(["route", "geocode"]), null);
  assert.equal(S.classifyPrediction(["premise", "locality"]), null);
  assert.equal(S.classifyPrediction(["postal_code", "geocode"]), null);
  assert.equal(S.classifyPrediction(["country", "political", "geocode"]), null);
  assert.equal(S.classifyPrediction(["hair_salon", "establishment", "point_of_interest"]), null);
  assert.equal(S.classifyPrediction(["supermarket", "store", "food"]), null);
  assert.equal(S.classifyPrediction([]), null);
  assert.equal(S.classifyPrediction(undefined), null);
});

test("groupPredictions splits into Places and Venues and drops the rest", () => {
  const g = S.groupPredictions([
    pred("geo1", "Rathmines", ["sublocality", "political", "geocode"], "Dublin, Ireland"),
    pred("ven1", "Rathmines Inn", ["pub", "bar", "establishment"], "Rathmines Road Lower"),
    pred("addr", "Rathmines Road", ["route", "geocode"]),
    pred("biz", "Rathmines Dental", ["dentist", "establishment"]),
    { queryPrediction: { text: { text: "rathmines pubs" } } },
    pred("geo1", "Rathmines (dup)", ["sublocality"]),
  ]);
  assert.deepEqual(g.places.map((p) => p.placeId), ["geo1"]);
  assert.deepEqual(g.venues.map((p) => p.placeId), ["ven1"]);
  assert.equal(g.places[0].mainText, "Rathmines");
  assert.equal(g.places[0].secondaryText, "Dublin, Ireland");
  assert.equal(g.venues[0].kind, "venue");
});

test("groupPredictions caps each group at 5", () => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push(pred(`g${i}`, `Town ${i}`, ["locality"]));
  for (let i = 0; i < 8; i++) many.push(pred(`v${i}`, `Pub ${i}`, ["pub"]));
  const g = S.groupPredictions(many);
  assert.equal(g.places.length, 5);
  assert.equal(g.venues.length, 5);
  assert.deepEqual(S.groupPredictions(null), { places: [], venues: [] });
});

test("isListedVenueRow follows the display rules", () => {
  assert.equal(S.isListedVenueRow({ place_id: "a", qualification_status: "confirmed", outdoor_seating: true }), true);
  assert.equal(S.isListedVenueRow({ place_id: "a", qualification_status: null, outdoor_seating: null }), true);
  assert.equal(S.isListedVenueRow({ place_id: "a", qualification_status: "unknown_after_enrichment" }), true);
  assert.equal(S.isListedVenueRow({ place_id: "a", qualification_status: "rejected_no_outdoor", outdoor_seating: false }), false);
  assert.equal(S.isListedVenueRow({ place_id: "a", qualification_status: "rejected_no_alcohol" }), false);
  assert.equal(S.isListedVenueRow({ place_id: "a", outdoor_seating: false }), false);
  assert.equal(S.isListedVenueRow(null), false);
});

test("escapeLike escapes ilike wildcards", () => {
  assert.equal(S.escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

test("LRU evicts the oldest entry, refreshes recency and expires by TTL", () => {
  const map = new Map();
  S.lruSet(map, "a", 1);
  S.lruSet(map, "b", 2);
  S.lruSet(map, "c", 3);
  assert.equal(S.lruGet(map, "a", 1000), 1); // "a" is now the most recent
  S.lruSave("test-key", map, 2);
  assert.deepEqual(Array.from(map.keys()), ["c", "a"]);
  map.get("c").t = Date.now() - 5000;
  assert.equal(S.lruGet(map, "c", 1000), undefined);
  assert.equal(map.has("c"), false);
});
