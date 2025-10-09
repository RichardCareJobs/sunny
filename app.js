
/* --------------------------------------------------------------------------
   Sunny — app.js (drop-in replacement)
   - Leaflet map + Overpass (OSM) loader
   - Broadened venue query (pub/bar/biergarten + restaurant/cafe w/ outdoor hints + hotel terraces)
   - Do NOT discard at import; mark with hasOutdoor and let UI filter in render
   - "Outdoor only" default OFF (shows more pins)
   - Simple localStorage cache
   - Uses /icons/sunny-32.png marker if available (falls back to default)
   -------------------------------------------------------------------------- */

(function () {
  // ---------------------------
  // Basic configuration
  // ---------------------------
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];

  // Initial map centre (Australia-wide view; users can pan/zoom)
  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 }; // Newcastle default for quick testing

  // Caching
  const VENUE_CACHE_KEY = "sunny-pubs-venues"; // all venues dictionary
  const TILE_CACHE_PREFIX = "sunny-pubs-overpass-tiles-v1:"; // per-bbox cache
  const TILE_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes per tile

  // UI defaults
  let outdoorOnly = false; // <— default OFF so more pins show first
  let openNowOnly = false; // available if you add a UI toggle with id="toggleOpenNow"

  // Map + layers
  let map;
  let markersLayer; // L.LayerGroup
  let allVenues = {}; // id => venue

  // Debounce for moveend
  let moveTimer = null;
  const MOVE_DEBOUNCE_MS = 500;

  // Custom marker icon (try your icon, fall back to Leaflet default)
  const CustomIcon = L.Icon.extend({
    options: {
      iconUrl: "/icons/sunny-32.png",
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -28],
      shadowUrl: undefined
    }
  });

  let markerIcon = null;

  // ---------------------------
  // Utility helpers
  // ---------------------------

  function log(...args) {
    const VERBOSE = false; // flip to true to debug
    if (VERBOSE) console.log("[Sunny]", ...args);
  }

  function getBBoxKey(b) {
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    // Round to 4dp so we don’t explode cache keys on tiny pans
    const r = (n) => +n.toFixed(4);
    return `${r(sw.lat)},${r(sw.lng)},${r(ne.lat)},${r(ne.lng)}`;
  }

  function saveLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ v: value, t: Date.now() }));
    } catch (e) {
      // storage full or disabled
      log("localStorage set error", e);
    }
  }

  function loadLocal(key, maxAgeMs = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { v, t } = JSON.parse(raw);
      if (maxAgeMs != null && Date.now() - t > maxAgeMs) return null;
      return v;
    } catch (e) {
      log("localStorage get error", e);
      return null;
    }
  }

  function toTitle(s = "") {
    if (!s) return "";
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---------------------------
  // Outdoor heuristic (broad, but safe)
  // ---------------------------
  function looksLikeBeerGarden(tags = {}) {
    const t = (x) => (x || "").toLowerCase();
    const name = t(tags.name);
    const desc = t(tags.description || tags.note || "");

    const outdoorTags =
      tags["outdoor_seating"] === "yes" ||
      tags["terrace"] === "yes" ||
      tags["roof_terrace"] === "yes" ||
      tags["garden"] === "yes" ||
      tags["patio"] === "yes";

    const nameHints = /beer ?garden|courtyard|terrace|rooftop|roof ?top|outdoor|al ?fresco/.test(
      name
    );
    const textHints = /courtyard|terrace|rooftop|beer ?garden|patio|alfresco/.test(desc);

    return !!(outdoorTags || nameHints || textHints);
  }

  // ---------------------------
  // Opening hours (placeholder)
  // ---------------------------
  function isOpenNow(tags) {
    // Minimal placeholder: treat unknown as open when openNowOnly==false
    // For future: parse tags.opening_hours via opening_hours.js
    if (!tags || !tags.opening_hours) return !openNowOnly;
    // naive: if tag contains "24/7" or "Mo-Su", assume open
    const oh = String(tags.opening_hours).toLowerCase();
    if (/24.?7/.test(oh)) return true;
    // Fallback: don't filter aggressively
    return !openNowOnly;
  }

  // ---------------------------
  // Overpass query
  // ---------------------------
  function buildOverpassQuery(bbox) {
    return `
      [out:json][timeout:25];
      (
        // Pubs/Bars/Biergarten — always grab
        node["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        way["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        relation["amenity"~"^(pub|bar|biergarten)$"](${bbox});

        // Restaurants/Cafes with outdoor hints
        node["amenity"~"^(restaurant|cafe)$"]["outdoor_seating"="yes"](${bbox});
        way["amenity"~"^(restaurant|cafe)$"]["outdoor_seating"="yes"](${bbox});
        relation["amenity"~"^(restaurant|cafe)$"]["outdoor_seating"="yes"](${bbox});

        node["amenity"~"^(restaurant|cafe)$"]["garden"="yes"](${bbox});
        way["amenity"~"^(restaurant|cafe)$"]["garden"="yes"](${bbox});
        relation["amenity"~"^(restaurant|cafe)$"]["garden"="yes"](${bbox});

        node["amenity"~"^(restaurant|cafe)$"]["terrace"="yes"](${bbox});
        way["amenity"~"^(restaurant|cafe)$"]["terrace"="yes"](${bbox});
        relation["amenity"~"^(restaurant|cafe)$"]["terrace"="yes"](${bbox});

        // Optional: hotels with outdoor areas
        node["tourism"="hotel"]["terrace"="yes"](${bbox});
        way["tourism"="hotel"]["terrace"="yes"](${bbox});
        relation["tourism"="hotel"]["terrace"="yes"](${bbox});
      );
      out center tags;
    `;
  }

  async function fetchOverpass(q) {
    const body = new URLSearchParams({ data: q });
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(url, { method: "POST", body });
        if (!res.ok) continue;
        const json = await res.json();
        if (json && json.elements) return json.elements;
      } catch (e) {
        // try next endpoint
        log("Overpass failed for", url, e);
      }
    }
    throw new Error("All Overpass endpoints failed");
  }

  // Convert Overpass element to a normalized venue (with center lat/lng)
  function elementToVenue(el) {
    const tags = el.tags || {};
    let lat = el.lat, lng = el.lon;
    if ((!lat || !lng) && el.center) {
      lat = el.center.lat;
      lng = el.center.lon;
    }
    if (!lat || !lng) return null;

    const id = `${el.type}/${el.id}`;
    const name =
      tags.name ||
      tags["brand"] ||
      toTitle(tags["operator"]) ||
      (tags.amenity ? toTitle(tags.amenity) : "Unnamed");

    const hasOutdoor = looksLikeBeerGarden(tags);

    return {
      id,
      name,
      lat,
      lng,
      tags,
      hasOutdoor,
      source: "osm"
    };
  }

  // ---------------------------
  // Venue storage / merge
  // ---------------------------
  function mergeVenues(newList) {
    let added = 0;
    for (const v of newList) {
      if (!v) continue;
      if (!allVenues[v.id]) {
        allVenues[v.id] = v;
        added++;
      } else {
        // update tags/flags if newer looks better
        allVenues[v.id] = { ...allVenues[v.id], ...v };
      }
    }
    if (added > 0) {
      saveLocal(VENUE_CACHE_KEY, allVenues);
    }
    return added;
  }

  function loadVenuesFromCache() {
    const cached = loadLocal(VENUE_CACHE_KEY);
    if (cached && typeof cached === "object") {
      allVenues = cached;
    }
  }

  // ---------------------------
  // Map + UI
  // ---------------------------
  function setupMap() {
    map = L.map("map").setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);

    // Try to use custom icon; if missing, fall back to default
    (function resolveIcon() {
      const testImg = new Image();
      testImg.onload = () => (markerIcon = new CustomIcon());
      testImg.onerror = () => (markerIcon = new L.Icon.Default());
      testImg.src = "/icons/sunny-32.png";
    })();

    map.on("moveend", debouncedLoadVisible);
    map.on("zoomend", debouncedLoadVisible);

    // Wire up toggles if they exist
    const toggleOutdoorEl = document.getElementById("toggleOutdoor");
    if (toggleOutdoorEl) {
      // Ensure UI matches default (off)
      toggleOutdoorEl.classList.remove("active");
      toggleOutdoorEl.addEventListener("click", () => {
        outdoorOnly = !outdoorOnly;
        toggleOutdoorEl.classList.toggle("active", outdoorOnly);
        renderMarkers();
      });
    }

    const toggleOpenNowEl = document.getElementById("toggleOpenNow");
    if (toggleOpenNowEl) {
      toggleOpenNowEl.classList.remove("active");
      toggleOpenNowEl.addEventListener("click", () => {
        openNowOnly = !openNowOnly;
        toggleOpenNowEl.classList.toggle("active", openNowOnly);
        renderMarkers();
      });
    }
  }

  function debouncedLoadVisible() {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(loadVisibleTiles, MOVE_DEBOUNCE_MS);
  }

  async function loadVisibleTiles() {
    const bboxKey = getBBoxKey(map.getBounds());
    const cacheKey = `${TILE_CACHE_PREFIX}${bboxKey}`;

    // If we have a fresh tile cache, use it
    const cached = loadLocal(cacheKey, TILE_CACHE_TTL_MS);
    if (cached && Array.isArray(cached)) {
      const venues = cached.map(elementToVenue).filter(Boolean);
      mergeVenues(venues);
      renderMarkers();
      return;
    }

    // Fetch from Overpass
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const bbox = [sw.lat, sw.lng, ne.lat, ne.lng].join(",");

    const query = buildOverpassQuery(bbox);

    try {
      const elements = await fetchOverpass(query);
      saveLocal(cacheKey, elements); // store raw so we can reparse with new heuristics in future
      const venues = elements.map(elementToVenue).filter(Boolean);
      mergeVenues(venues);
      renderMarkers();
    } catch (e) {
      console.error("Overpass error:", e);
    }
  }

  function venueMatchesFilters(v) {
    if (outdoorOnly && !v.hasOutdoor) return false;
    if (openNowOnly && !isOpenNow(v.tags)) return false;
    return true;
  }

  function renderMarkers() {
    markersLayer.clearLayers();
    const b = map.getBounds();

    const visible = [];
    for (const id in allVenues) {
      const v = allVenues[id];
      if (!v) continue;
      if (!b.contains([v.lat, v.lng])) continue;
      if (!venueMatchesFilters(v)) continue;
      visible.push(v);
    }

    visible.forEach((v) => {
      const icon = markerIcon || new L.Icon.Default();
      const marker = L.marker([v.lat, v.lng], { icon }).addTo(markersLayer);

      const tags = v.tags || {};
      const parts = [];
      if (tags.amenity || tags.tourism) parts.push(`<div><strong>${toTitle(tags.amenity || tags.tourism)}</strong></div>`);
      if (v.hasOutdoor) parts.push(`<div>🌿 Outdoor friendly</div>`);
      if (tags.opening_hours) parts.push(`<div>Hours: ${tags.opening_hours}</div>`);
      if (tags.website) {
        const safeUrl = String(tags.website).replace(/^http:\/\//, "https://");
        parts.push(`<div><a href="${safeUrl}" target="_blank" rel="noopener">Website</a></div>`);
      }
      if (tags["addr:street"] || tags["addr:city"]) {
        const addr = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]]
          .filter(Boolean)
          .join(" ");
        if (addr) parts.push(`<div>${addr}</div>`);
      }

      const popupHtml = `
        <div class="venue-popup">
          <div class="venue-name"><strong>${v.name}</strong></div>
          ${parts.join("")}
        </div>
      `;

      marker.bindPopup(popupHtml);
    });
  }

  // ---------------------------
  // Boot
  // ---------------------------
  function boot() {
    // Load cached state first so we can show pins quickly
    loadVenuesFromCache();
    setupMap();
    renderMarkers();
    // Trigger initial load
    debouncedLoadVisible();
  }

  // Ensure DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
