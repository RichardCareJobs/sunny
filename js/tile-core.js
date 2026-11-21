/*
  Sunny — tile-core.js
  Pure, dependency-free logic that decides when the map needs a fresh (billed)
  Google Places search, and remembers what earlier searches already covered.
  Loads as a classic <script> (exposes window.SunnyTiles) and via require() in
  Node for the tests.

  Why this exists: every map search fires 4–5 Places Pro calls. Before this
  module the app re-searched whenever the map centre crossed a 0.05° grid line,
  even though the previous search (12 km radius) already covered the view, and
  the cache lived in sessionStorage so every new visit paid again.

  Coverage model
  --------------
  Each completed search is stored as an entry:
    { key, lat, lng, coverRadiusM, filterHash, ts, venues }
  coverRadiusM is how far the search provably found every primary venue:
  Nearby Search is ranked by DISTANCE and capped at 20 results, so
    - fewer than 20 results  -> it found everything within the search radius
    - 20 results (saturated) -> it found everything out to the 20th result
  A viewport is "covered" when it sits in the same grid cell as an entry (the
  old behaviour) or when most of it falls inside an entry's coverRadiusM.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnyTiles = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CELL_DEG = 0.05;                       // ~5.5 km north–south
  const SEARCH_RADIUS_M = 12000;               // matches PLACES_QUERY_RADIUS_MAX_M in app.js
  const NEARBY_MAX_RESULTS = 20;               // Places API (New) maxResultCount cap
  const MIN_SEARCH_ZOOM = 11;                  // below this, don't start new searches
  const VIEWPORT_COVER_FRACTION = 0.6;         // how much of the view radius must be covered
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 40;
  const EARTH_RADIUS_M = 6371000;

  function toRad(d) { return d * Math.PI / 180; }

  function distanceM(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function snap(value, grid = CELL_DEG) {
    // Round to grid, then trim float noise so -0.05 and -0.05000000001 agree.
    const snapped = Math.round(value / grid) * grid;
    return Number(snapped.toFixed(4)) || 0;
  }

  function cellKey(lat, lng, filterHash = "", grid = CELL_DEG) {
    if (typeof lat !== "number" || typeof lng !== "number" || !isFinite(lat) || !isFinite(lng)) return "";
    return `${snap(lat, grid).toFixed(3)}:${snap(lng, grid).toFixed(3)}:${filterHash}`;
  }

  // Half the viewport diagonal, i.e. the radius of the smallest circle around the
  // centre that contains the whole view.
  function viewRadiusM(center, northEast) {
    if (!center || !northEast) return 0;
    return distanceM(center.lat, center.lng, northEast.lat, northEast.lng);
  }

  // How far a search provably found every primary venue (see header).
  // nearbyDistancesM: distances from the search centre of the Nearby results.
  function coverRadiusM(nearbyDistancesM, {
    searchRadiusM = SEARCH_RADIUS_M,
    maxResults = NEARBY_MAX_RESULTS,
  } = {}) {
    const list = Array.isArray(nearbyDistancesM) ? nearbyDistancesM.filter(d => typeof d === "number" && isFinite(d)) : [];
    if (list.length < maxResults) return searchRadiusM;
    return Math.min(searchRadiusM, Math.max(...list));
  }

  function isFresh(entry, now = Date.now(), ttlMs = CACHE_TTL_MS) {
    return !!entry && typeof entry.ts === "number" && now - entry.ts <= ttlMs && now >= entry.ts - 60000;
  }

  // Returns the entry that already covers this viewport, or null.
  // view: { lat, lng, radiusM, filterHash }
  function findCoveringEntry(entries, view, { now = Date.now(), ttlMs = CACHE_TTL_MS, coverFraction = VIEWPORT_COVER_FRACTION } = {}) {
    if (!view || typeof view.lat !== "number" || typeof view.lng !== "number") return null;
    const list = entries instanceof Map ? [...entries.values()] : (Array.isArray(entries) ? entries : []);
    const key = cellKey(view.lat, view.lng, view.filterHash || "");
    let best = null;
    let bestSlack = -Infinity;
    for (const entry of list) {
      if (!isFresh(entry, now, ttlMs)) continue;
      if ((entry.filterHash || "") !== (view.filterHash || "")) continue;
      if (entry.key && entry.key === key) return entry;
      if (typeof entry.lat !== "number" || typeof entry.lng !== "number" || typeof entry.coverRadiusM !== "number") continue;
      const needed = distanceM(view.lat, view.lng, entry.lat, entry.lng) + (view.radiusM || 0) * coverFraction;
      const slack = entry.coverRadiusM - needed;
      if (slack >= 0 && slack > bestSlack) { best = entry; bestSlack = slack; }
    }
    return best;
  }

  function shouldSearchAtZoom(zoom, minZoom = MIN_SEARCH_ZOOM) {
    return typeof zoom !== "number" || zoom >= minZoom;
  }

  // Drop stale entries and keep the most recent maxEntries. Returns a new array.
  function pruneEntries(entries, { now = Date.now(), ttlMs = CACHE_TTL_MS, maxEntries = CACHE_MAX_ENTRIES } = {}) {
    const list = entries instanceof Map ? [...entries.values()] : (Array.isArray(entries) ? entries : []);
    return list
      .filter(entry => entry && entry.key && isFresh(entry, now, ttlMs))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, maxEntries);
  }

  // ── Call budget (session circuit breaker) ──────────────────────────────────
  // Caps how many billed search calls one browser can make in rolling windows,
  // so a runaway loop or a bot driving the UI can't run up the bill. Real visitors
  // averaged ~20 calls per session in November 2026.
  const DEFAULT_BUDGET_LIMITS = [
    { windowMs: 10 * 60 * 1000, max: 60 },
    { windowMs: 24 * 60 * 60 * 1000, max: 200 },
  ];

  function createCallBudget({ limits = DEFAULT_BUDGET_LIMITS, load = () => [], save = () => {}, now = () => Date.now() } = {}) {
    const longest = Math.max(...limits.map(l => l.windowMs));
    let stamps = [];
    try {
      const loaded = load();
      if (Array.isArray(loaded)) stamps = loaded.filter(t => typeof t === "number");
    } catch { stamps = []; }

    function trim(t) {
      stamps = stamps.filter(s => t - s <= longest && s <= t + 60000);
    }
    function canSpend(n = 1) {
      const t = now();
      trim(t);
      return limits.every(l => stamps.filter(s => t - s <= l.windowMs).length + n <= l.max);
    }
    function spend(n = 1) {
      const t = now();
      trim(t);
      for (let i = 0; i < n; i++) stamps.push(t);
      try { save(stamps); } catch { /* storage full or blocked */ }
    }
    function used(windowMs = limits[0].windowMs) {
      const t = now();
      return stamps.filter(s => t - s <= windowMs).length;
    }
    return { canSpend, spend, used };
  }

  return {
    CELL_DEG, SEARCH_RADIUS_M, NEARBY_MAX_RESULTS, MIN_SEARCH_ZOOM, VIEWPORT_COVER_FRACTION,
    CACHE_TTL_MS, CACHE_MAX_ENTRIES, DEFAULT_BUDGET_LIMITS,
    distanceM, snap, cellKey, viewRadiusM, coverRadiusM, isFresh,
    findCoveringEntry, shouldSearchAtZoom, pruneEntries, createCallBudget,
  };
});
