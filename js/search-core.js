/*
  Sunny — search-core.js
  Pure, dependency-free logic for the header search box: query normalisation,
  classifying Places Autocomplete (New) predictions by their `types`, grouping
  them for the dropdown, and deciding whether a venue_details row counts as
  "listed". Loads as a classic <script> (exposes window.SunnySearch) and via
  require() in Node for the tests.

  Type names follow the Places API (New) type tables (Table A "Food and Drink",
  Table A/B geographic types), checked November 2026.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnySearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_PER_GROUP = 5;

  // Suburbs, cities and similar areas. Countries are left out on purpose:
  // fitting the map to a whole country loads nothing useful.
  const GEO_TYPES = new Set([
    "locality", "postal_town", "neighborhood", "colloquial_area",
    "sublocality", "sublocality_level_1", "sublocality_level_2",
    "sublocality_level_3", "sublocality_level_4", "sublocality_level_5",
    "administrative_area_level_1", "administrative_area_level_2",
    "administrative_area_level_3",
  ]);

  // A prediction carrying any of these is an address, not a place to browse.
  const ADDRESS_TYPES = new Set([
    "street_address", "route", "premise", "subpremise", "intersection",
    "plus_code", "postal_code", "postal_code_prefix", "postal_code_suffix",
    "street_number", "floor", "room", "post_box",
  ]);

  // Food and drink establishments. Any "<cuisine>_restaurant" also counts.
  const VENUE_TYPES = new Set([
    "bar", "pub", "irish_pub", "gastropub", "beer_garden", "brewery", "brewpub",
    "wine_bar", "cocktail_bar", "sports_bar", "lounge_bar", "hookah_bar",
    "bar_and_grill", "night_club", "winery", "bistro", "restaurant", "cafe",
    "coffee_shop", "tea_house", "food_court", "steak_house", "diner", "deli",
  ]);

  function normaliseQuery(value) {
    return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isVenueType(type) {
    return VENUE_TYPES.has(type) || /_restaurant$/.test(type);
  }

  // -> "geo" | "venue" | null (null = drop: addresses, unrelated businesses)
  function classifyPrediction(types) {
    const list = Array.isArray(types) ? types.map((t) => String(t).toLowerCase()) : [];
    if (!list.length) return null;
    if (list.some(isVenueType)) return "venue";
    if (list.some((t) => ADDRESS_TYPES.has(t))) return null;
    if (list.some((t) => GEO_TYPES.has(t))) return "geo";
    return null;
  }

  // Raw `suggestions` array from places:autocomplete -> { places: [], venues: [] }
  function groupPredictions(suggestions, maxPerGroup) {
    const max = Number.isFinite(maxPerGroup) ? maxPerGroup : MAX_PER_GROUP;
    const out = { places: [], venues: [] };
    const seen = new Set();
    (Array.isArray(suggestions) ? suggestions : []).forEach((s) => {
      const p = s && s.placePrediction;
      if (!p || !p.placeId || seen.has(p.placeId)) return;
      const types = Array.isArray(p.types) ? p.types : [];
      const kind = classifyPrediction(types);
      if (!kind) return;
      const mainText = (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) ||
        (p.text && p.text.text) || "";
      if (!mainText) return;
      const secondaryText = (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "";
      const target = kind === "geo" ? out.places : out.venues;
      if (target.length >= max) return;
      seen.add(p.placeId);
      target.push({ kind, placeId: p.placeId, mainText, secondaryText, types });
    });
    return out;
  }

  // A venue_details row counts as listed (normal pin and card) unless Sunny has
  // rejected it or knows it has no outdoor seating. Rows are only ever written
  // for venues that already passed the map's filters.
  function isListedVenueRow(row) {
    if (!row || !row.place_id) return false;
    const status = String(row.qualification_status || "");
    if (status.indexOf("rejected_") === 0) return false;
    if (row.outdoor_seating === false) return false;
    return true;
  }

  // Escape a user string for use inside a PostgREST ilike pattern.
  function escapeLike(value) {
    return String(value == null ? "" : value).replace(/[\\%_]/g, (c) => "\\" + c);
  }

  // ── Small sessionStorage LRU, same shape as the one in sun-ui.js ───────────
  function storage() {
    try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch (e) { return null; }
  }
  function lruLoad(key) {
    try { return new Map(JSON.parse((storage() && storage().getItem(key)) || "[]")); } catch (e) { return new Map(); }
  }
  function lruSave(key, map, max) {
    const entries = Array.from(map.entries());
    while (entries.length > max) { map.delete(entries.shift()[0]); }
    try { const s = storage(); if (s) s.setItem(key, JSON.stringify(entries)); } catch (e) { /* quota or private mode */ }
  }
  function lruGet(map, k, ttl) {
    const e = map.get(k);
    if (!e) return undefined;
    if (Date.now() - e.t > ttl) { map.delete(k); return undefined; }
    map.delete(k); map.set(k, e); // refresh recency
    return e.v;
  }
  function lruSet(map, k, v) {
    map.delete(k);
    map.set(k, { v, t: Date.now() });
  }

  return {
    MAX_PER_GROUP, GEO_TYPES, ADDRESS_TYPES, VENUE_TYPES,
    normaliseQuery, classifyPrediction, groupPredictions, isListedVenueRow, escapeLike,
    lruLoad, lruSave, lruGet, lruSet,
  };
});
