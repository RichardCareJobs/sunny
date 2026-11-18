/*
  Sunny — qualification-core.js
  Pure, dependency-free logic for venue qualification: turning a Google Places
  result into a qualification_status, and deciding when a venue_details row may
  be refreshed from Places at all. Loads as a classic <script> (exposes
  window.SunnyQualification) and via require() in Node for the tests.

  Rule: a row whose qualification_status starts with "rejected_" is locked.
  The client never calls Places for it and never overwrites it, however old
  it is. Only an editorial/admin action (SQL or the service role) changes it.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnyQualification = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function isEditoriallyLocked(status) {
    return String(status || "").indexOf("rejected_") === 0;
  }

  function qualifyFromPlace(place) {
    const outdoorKnown = typeof place?.outdoorSeating === "boolean";
    const alcoholFields = [place?.servesBeer, place?.servesWine, place?.servesCocktails];
    const servesAlcohol = alcoholFields.some((v) => v === true);
    const alcoholKnown = alcoholFields.some((v) => typeof v === "boolean");
    if (place?.outdoorSeating === true && servesAlcohol) return "confirmed";
    if (outdoorKnown && place.outdoorSeating === false) return "rejected_no_outdoor";
    if (alcoholKnown && !servesAlcohol) return "rejected_no_alcohol";
    return "unknown_after_enrichment";
  }

  // Dependencies (all may be async):
  //   readRow(placeId)            -> { qualification_status, last_enriched_at } | null
  //                                  (throw or return null when unknown)
  //   fetchPlace(placeId)         -> Places result with outdoorSeating / serves* fields
  //   saveRow(placeId, place, qualificationStatus, context)
  //   onCacheHit(placeId, status, context)            optional
  //   onEnriched(placeId, place, status, context)     optional
  //   now()                       -> ms timestamp (defaults to Date.now)
  //   ttlMs                       -> freshness window for "confirmed" rows
  // enrich() resolves to { qualificationStatus, cacheHit, locked? } or null on failure.
  function createQualificationEnricher(deps) {
    const readRow = deps.readRow;
    const fetchPlace = deps.fetchPlace;
    const saveRow = deps.saveRow;
    const onCacheHit = deps.onCacheHit || function () {};
    const onEnriched = deps.onEnriched || function () {};
    const now = deps.now || function () { return Date.now(); };
    const ttlMs = typeof deps.ttlMs === "number" ? deps.ttlMs : DEFAULT_TTL_MS;

    async function safeRead(placeId) {
      try { return (await readRow(placeId)) || null; } catch (e) { return null; }
    }

    return async function enrich(placeId, enrichmentType, enrichmentReason, scoreData) {
      if (!placeId) return null;
      const context = { enrichmentType, enrichmentReason, scoreData: scoreData || {} };
      const row = await safeRead(placeId);
      const status = (row && row.qualification_status) || "";

      if (isEditoriallyLocked(status)) {
        onCacheHit(placeId, status, context);
        return { qualificationStatus: status, cacheHit: true, locked: true };
      }
      if (status === "confirmed" && row.last_enriched_at) {
        const age = now() - new Date(row.last_enriched_at).getTime();
        if (age <= ttlMs) {
          onCacheHit(placeId, status, context);
          return { qualificationStatus: status, cacheHit: true };
        }
      }

      try {
        const place = await fetchPlace(placeId);
        const qualificationStatus = qualifyFromPlace(place);
        // A rejection may have landed while Places was answering (or the first
        // read failed): look again and never write over it.
        const latest = await safeRead(placeId);
        const latestStatus = (latest && latest.qualification_status) || "";
        if (isEditoriallyLocked(latestStatus)) {
          onCacheHit(placeId, latestStatus, context);
          return { qualificationStatus: latestStatus, cacheHit: false, locked: true };
        }
        await saveRow(placeId, place, qualificationStatus, context);
        onEnriched(placeId, place, qualificationStatus, context);
        return { qualificationStatus, cacheHit: false };
      } catch (e) {
        return null;
      }
    };
  }

  return { DEFAULT_TTL_MS, isEditoriallyLocked, qualifyFromPlace, createQualificationEnricher };
});
