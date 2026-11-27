/*
  Sunny — venue-cta-core.js
  Pure, dependency-free logic for the venue card call to action: turns the
  straight-line distance (km) between the user and a venue into the distance
  line ("~12 min walk" / "~4.4 km drive") and picks which button is the main
  one. No network calls. Loads as a classic <script> (exposes
  window.SunnyVenueCta) and via require() in Node for the tests.

  Estimates: route factor 1.3 over the straight line, walking at 5 km/h.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnyVenueCta = api;
})(typeof self !== "undefined" ? self : this, function () {
  const ROUTE_FACTOR = 1.3;
  const WALK_KMH = 5;
  const WALK_LINE_MAX_KM = 3;     // under this: show walk time; at or over: drive distance
  const WALK_PRIMARY_MAX_KM = 2;  // under this: Directions is the main button; at or over: Uber

  const NONE = Object.freeze({ mode: "none", line: null, primary: null, distanceKm: null, walkMin: null, driveKm: null });

  function walkMinutes(km) {
    return Math.max(1, Math.round((km * ROUTE_FACTOR / WALK_KMH) * 60));
  }

  function driveKm(km) {
    return (km * ROUTE_FACTOR).toFixed(1);
  }

  // km: straight-line (haversine) distance, or null when location isn't shared.
  function getVenueCta(km) {
    if (km === null || km === undefined || typeof km !== "number" || !Number.isFinite(km) || km < 0) return NONE;
    const walkMin = walkMinutes(km);
    const drive = driveKm(km);
    const isWalkLine = km < WALK_LINE_MAX_KM;
    return {
      mode: isWalkLine ? "walk" : "drive",
      line: isWalkLine ? `~${walkMin} min walk` : `~${drive} km drive`,
      primary: km < WALK_PRIMARY_MAX_KM ? "directions" : "uber",
      distanceKm: Math.round(km * 10) / 10,
      walkMin,
      driveKm: drive,
    };
  }

  return { ROUTE_FACTOR, WALK_KMH, WALK_LINE_MAX_KM, WALK_PRIMARY_MAX_KM, walkMinutes, driveKm, getVenueCta };
});
