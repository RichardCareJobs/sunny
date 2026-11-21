/*
  Sunny — qualification-core.js
  Pure, dependency-free logic for venue qualification: turning a Google Places
  result into a qualification_status, and deciding when a venue_details row may
  be refreshed from Places at all. Loads as a classic <script> (exposes
  window.SunnyQualification) and via require() in Node for the tests.

  Rule: a row whose qualification_status starts with "rejected_" is locked.
  The client never calls Places for it and never overwrites it, however old
  it is. Only an editorial/admin action (SQL or the service role) changes it.
  The database enforces the same rule (migration 20261118200000): the public
  key can neither change a rejected_ status nor set one. So a negative Places
  result is stored as unknown_after_enrichment plus the facts behind it, and
  those facts are what keep it from being re-checked for 30 days.

  A Places check that came back with no facts at all (Google simply doesn't
  know) is also left alone for 30 days: asking again on every card open costs
  an Enterprise + Atmosphere call and gets the same empty answer. Rows from
  other sources (e.g. the Apify import) are still checked with Places.
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

  // Only an explicit boolean from Places is stored; a missing field is null,
  // never false (outdoor_seating=false hides a venue from search).
  function placeFacts(place) {
    const pick = (v) => (typeof v === "boolean" ? v : null);
    return {
      outdoor_seating: pick(place?.outdoorSeating),
      serves_beer: pick(place?.servesBeer),
      serves_wine: pick(place?.servesWine),
      serves_cocktails: pick(place?.servesCocktails),
    };
  }

  // The status the public key may write: rejections are left to editorial/service role.
  function storableStatus(status) {
    return isEditoriallyLocked(status) ? "unknown_after_enrichment" : String(status || "");
  }

  // The status implied by facts already stored on a venue_details row.
  function qualifyFromRow(row) {
    return qualifyFromPlace({
      outdoorSeating: row?.outdoor_seating,
      servesBeer: row?.serves_beer,
      servesWine: row?.serves_wine,
      servesCocktails: row?.serves_cocktails,
    });
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
  //   readRow(placeId)            -> { qualification_status, last_enriched_at,
  //                                    outdoor_seating, serves_beer, serves_wine, serves_cocktails } | null
  //                                  (throw or return null when unknown)
  //   fetchPlace(placeId)         -> Places result with outdoorSeating / serves* fields
  //   saveRow(placeId, fields, context)   fields = { qualification_status (storable), ...placeFacts }
  //   onCacheHit(placeId, status, context)            optional
  //   onEnriched(placeId, place, status, context)     optional
  //   now()                       -> ms timestamp (defaults to Date.now)
  //   ttlMs                       -> freshness window for "confirmed" rows and for
  //                                  Places-checked unknown rows
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

    // One lookup per venue at a time: the card re-renders while details load, and
    // background enrichment can ask about the same venue concurrently.
    const inFlight = new Map();
    return function enrich(placeId, enrichmentType, enrichmentReason, scoreData) {
      if (!placeId) return Promise.resolve(null);
      if (inFlight.has(placeId)) return inFlight.get(placeId);
      const pending = enrichOnce(placeId, enrichmentType, enrichmentReason, scoreData)
        .finally(() => inFlight.delete(placeId));
      inFlight.set(placeId, pending);
      return pending;
    };

    async function enrichOnce(placeId, enrichmentType, enrichmentReason, scoreData) {
      const context = { enrichmentType, enrichmentReason, scoreData: scoreData || {} };
      const row = await safeRead(placeId);
      const status = (row && row.qualification_status) || "";

      if (isEditoriallyLocked(status)) {
        onCacheHit(placeId, status, context);
        return { qualificationStatus: status, cacheHit: true, locked: true };
      }
      const fresh = !!(row && row.last_enriched_at) &&
        now() - new Date(row.last_enriched_at).getTime() <= ttlMs;
      if (fresh && status === "confirmed") {
        onCacheHit(placeId, status, context);
        return { qualificationStatus: status, cacheHit: true };
      }
      // A recent negative Places result, stored as facts (see header).
      const fromFacts = row ? qualifyFromRow(row) : "";
      if (fresh && isEditoriallyLocked(fromFacts)) {
        onCacheHit(placeId, fromFacts, context);
        return { qualificationStatus: fromFacts, cacheHit: true };
      }
      // A recent Places check that had nothing to say (see header).
      if (fresh && status === "unknown_after_enrichment" && row.enrichment_source === "places_api") {
        onCacheHit(placeId, status, context);
        return { qualificationStatus: status, cacheHit: true };
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
        await saveRow(placeId, { qualification_status: storableStatus(qualificationStatus), ...placeFacts(place) }, context);
        onEnriched(placeId, place, qualificationStatus, context);
        return { qualificationStatus, cacheHit: false };
      } catch (e) {
        return null;
      }
    }
  }

  return {
    DEFAULT_TTL_MS, isEditoriallyLocked, placeFacts, storableStatus,
    qualifyFromPlace, qualifyFromRow, createQualificationEnricher,
  };
});
