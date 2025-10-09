
/* --------------------------------------------------------------------------
   Sunny — app.js (v2 hotfix)
   Addresses:
   1) Basemap reverted -> use CartoDB Positron by default (clean, light).
   2) Cards lacked sun/directions/uber -> List view with cards restored (or created if missing).
   3) Map/List/Filter buttons non-functional -> robust wiring (auto-create if not found).
   4) Cafes showing -> removed cafes from query (keep restaurants w/ outdoor hints).
   5) Filters not showing -> auto-create floating Filters panel with Outdoor/Open Now toggles.
   -------------------------------------------------------------------------- */

(function () {
  // ---------------------------
  // Config
  // ---------------------------
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];

  // Start focused on Newcastle for verification
  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 };

  // Tile layer (CartoDB Positron)
  const TILE_URL = window.SUNNY_TILE_URL ||
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const TILE_ATTR =
    window.SUNNY_TILE_ATTR ||
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  // Cache
  const VENUE_CACHE_KEY = "sunny-pubs-venues";
  const TILE_CACHE_PREFIX = "sunny-pubs-overpass-tiles-v1:";
  const TILE_CACHE_TTL_MS = 1000 * 60 * 30;

  // UI State
  let outdoorOnly = false;
  let openNowOnly = false;
  let currentView = "map"; // "map" | "list"

  // Map + data
  let map, markersLayer;
  let allVenues = {};

  // Debounce for moveend
  let moveTimer = null;
  const MOVE_DEBOUNCE_MS = 500;

  // Marker icon
  let markerIcon = null;
  const CustomIcon = L.Icon.extend({
    options: {
      iconUrl: "/icons/sunny-32.png",
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -28]
    }
  });

  // ---------------------------
  // Helpers
  // ---------------------------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function ensureEl(id, html) {
    let el = document.getElementById(id);
    if (!el) {
      const div = document.createElement("div");
      div.id = id;
      div.innerHTML = html || "";
      document.body.appendChild(div);
      el = div;
    }
    return el;
  }

  function saveLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ v: value, t: Date.now() })); } catch {}
  }
  function loadLocal(key, maxAgeMs = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { v, t } = JSON.parse(raw);
      if (maxAgeMs != null && Date.now() - t > maxAgeMs) return null;
      return v;
    } catch { return null; }
  }
  function toTitle(s = "") { return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : ""; }

  // ---------------------------
  // Sun (compact approximate calc)
  // Returns {azimuthDeg (0=N), altitudeDeg}
  // Source: simplified variant of commonly used SunCalc approximations
  // ---------------------------
  function sunPosition(lat, lng, date=new Date()) {
    const rad = Math.PI/180, deg = 180/Math.PI;
    const J1970 = 2440588, J2000 = 2451545;
    const dayMs = 1000 * 60 * 60 * 24;
    const toJulian = (d) => d/ dayMs - 0.5 + J1970;
    const dateToJulian = (date) => toJulian(date.getTime());
    const d = dateToJulian(date) - J2000;

    // solar mean anomaly
    const M = rad * (357.5291 + 0.98560028 * d);
    // equation of center
    const C = rad * (1.9148*Math.sin(M) + 0.02*Math.sin(2*M) + 0.0003*Math.sin(3*M));
    // ecliptic longitude
    const P = rad * 102.9372; // perihelion
    const L = M + C + P + Math.PI;

    // obliquity of the Earth
    const e = rad * 23.4397;
    const sinDec = Math.sin(e) * Math.sin(L);
    const cosDec = Math.cos(Math.asin(sinDec));

    // sidereal time
    const lw = rad * -lng;
    const phi = rad * lat;
    const n = Math.round(d - 0.0009 - lw/(2*Math.PI));
    const Jstar = 0.0009 + (lw)/(2*Math.PI) + n;
    const Jtransit = Jstar + 0.0053*Math.sin(M) - 0.0069*Math.sin(2*L);
    const theta = rad * (280.16 + 360.9856235 * (d - J2000 - 0.0009)) - lw;

    const H = theta - L; // hour angle

    const altitude = Math.asin(Math.sin(phi)*sinDec + Math.cos(phi)*cosDec*Math.cos(H));
    const azimuth = Math.atan2(Math.sin(H), Math.cos(H)*Math.sin(phi) - Math.tan(Math.asin(sinDec))*Math.cos(phi));

    let azimuthDeg = (azimuth*deg + 180) % 360; // convert to 0..360 from North
    let altitudeDeg = altitude*deg;
    return { azimuthDeg, altitudeDeg };
  }

  function formatSunInfo(lat, lng) {
    const s = sunPosition(lat, lng, new Date());
    const dir = azimuthToCompass(s.azimuthDeg);
    return `Sun now: ${dir} (${s.azimuthDeg.toFixed(0)}°), alt ${s.altitudeDeg.toFixed(0)}°`;
  }
  function azimuthToCompass(a) {
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return dirs[Math.round(a/22.5) % 16];
  }

  // ---------------------------
  // Heuristics
  // ---------------------------
  function looksOutdoor(tags = {}) {
    const t = (x) => (x || "").toLowerCase();
    const name = t(tags.name);
    const desc = t(tags.description || tags.note || "");
    const outdoorTags =
      tags["outdoor_seating"] === "yes" ||
      tags["terrace"] === "yes" ||
      tags["roof_terrace"] === "yes" ||
      tags["garden"] === "yes" ||
      tags["patio"] === "yes";
    const nameHints = /beer ?garden|courtyard|terrace|rooftop|roof ?top|outdoor|al ?fresco/.test(name);
    const textHints = /courtyard|terrace|rooftop|beer ?garden|patio|alfresco/.test(desc);
    return !!(outdoorTags || nameHints || textHints);
  }

  function isOpenNow(tags) {
    if (!tags || !tags.opening_hours) return !openNowOnly;
    if (/24.?7/i.test(String(tags.opening_hours))) return true;
    return !openNowOnly;
  }

  // ---------------------------
  // Overpass
  // ---------------------------
  function buildOverpassQuery(bbox) {
    // Cafes removed per request. Keep restaurants with outdoor hints.
    return `
      [out:json][timeout:25];
      (
        // Pubs/Bars/Biergarten — always grab
        node["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        way["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        relation["amenity"~"^(pub|bar|biergarten)$"](${bbox});

        // Restaurants with outdoor hints
        node["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        way["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        relation["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});

        node["amenity"="restaurant"]["garden"="yes"](${bbox});
        way["amenity"="restaurant"]["garden"="yes"](${bbox});
        relation["amenity"="restaurant"]["garden"="yes"](${bbox});

        node["amenity"="restaurant"]["terrace"="yes"](${bbox});
        way["amenity"="restaurant"]["terrace"="yes"](${bbox});
        relation["amenity"="restaurant"]["terrace"="yes"](${bbox});

        // Hotels with outdoor areas
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
      } catch {}
    }
    throw new Error("All Overpass endpoints failed");
  }

  function normalizeElement(el) {
    const tags = el.tags || {};
    let lat = el.lat, lng = el.lon;
    if ((!lat || !lng) && el.center) { lat = el.center.lat; lng = el.center.lon; }
    if (!lat || !lng) return null;
    const id = `${el.type}/${el.id}`;
    const name = tags.name || tags.brand || toTitle(tags.operator) || (tags.amenity ? toTitle(tags.amenity) : "Unnamed");
    return {
      id, name, lat, lng, tags,
      hasOutdoor: looksOutdoor(tags),
      source: "osm"
    };
  }

  function mergeVenues(list) {
    let added = 0;
    for (const v of list) {
      if (!v) continue;
      if (!allVenues[v.id]) { allVenues[v.id] = v; added++; }
      else { allVenues[v.id] = { ...allVenues[v.id], ...v }; }
    }
    if (added) saveLocal(VENUE_CACHE_KEY, allVenues);
  }

  // ---------------------------
  // UI Wiring (robust; creates fallbacks)
  // ---------------------------
  function ensureUI() {
    // Map/List buttons
    let controls = document.getElementById("sunny-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.id = "sunny-controls";
      controls.style.position = "fixed";
      controls.style.right = "16px";
      controls.style.bottom = "16px";
      controls.style.display = "flex";
      controls.style.gap = "8px";
      controls.style.zIndex = 1000;
      controls.innerHTML = `
        <button id="btnFilters" class="sunny-chip">Filters</button>
        <button id="btnMap" class="sunny-chip sunny-chip-active">Map</button>
        <button id="btnList" class="sunny-chip">List</button>
      `;
      document.body.appendChild(controls);
      const style = document.createElement("style");
      style.textContent = `
        .sunny-chip{background:#111;color:#fff;border:none;border-radius:999px;padding:10px 14px;cursor:pointer;opacity:.95}
        .sunny-chip-active{background:#4a4a4a}
        #sunny-filters{position:fixed;right:16px;bottom:72px;z-index:1001;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.15);padding:12px;display:none;min-width:220px}
        #list { position: absolute; left: 0; right: 0; bottom: 0; top: 0; overflow: auto; background: #fff; display:none; }
        .card { border-bottom:1px solid #eee; padding:14px 16px; }
        .card h3 { margin:0 0 6px 0; font-size:16px; }
        .badge { display:inline-block; background:#eef6e9; color:#245d15; border-radius:6px; padding:2px 6px; margin-right:6px; font-size:12px;}
        .meta { color:#555; font-size:12px; margin-top:6px; }
        .links a { margin-right:10px; font-size:12px; }
      `;
      document.head.appendChild(style);
    }

    // Filters panel
    ensureEl("sunny-filters", `
      <div><label><input type="checkbox" id="toggleOutdoor"> Outdoor only</label></div>
      <div style="margin-top:6px;"><label><input type="checkbox" id="toggleOpenNow"> Open now</label></div>
    `);

    // List container
    ensureEl("list", "");

    // Map container must exist in HTML
    if (!document.getElementById("map")) {
      const m = document.createElement("div");
      m.id = "map";
      m.style.position = "absolute";
      m.style.left = "0"; m.style.right = "0"; m.style.top = "0"; m.style.bottom = "0";
      document.body.appendChild(m);
    }

    // Wire buttons
    const btnMap = document.getElementById("btnMap");
    const btnList = document.getElementById("btnList");
    const btnFilters = document.getElementById("btnFilters");
    const filtersPanel = document.getElementById("sunny-filters");

    btnMap.onclick = () => { currentView = "map"; btnMap.classList.add("sunny-chip-active"); btnList.classList.remove("sunny-chip-active"); document.getElementById("map").style.display="block"; document.getElementById("list").style.display="none"; };
    btnList.onclick = () => { currentView = "list"; btnList.classList.add("sunny-chip-active"); btnMap.classList.remove("sunny-chip-active"); document.getElementById("map").style.display="none"; document.getElementById("list").style.display="block"; renderList(); };
    btnFilters.onclick = () => { filtersPanel.style.display = (filtersPanel.style.display==="none"||!filtersPanel.style.display) ? "block":"none"; };

    // Toggles
    const tOut = document.getElementById("toggleOutdoor");
    const tOpen = document.getElementById("toggleOpenNow");
    tOut.checked = outdoorOnly; tOpen.checked = openNowOnly;
    tOut.onchange = () => { outdoorOnly = tOut.checked; renderAll(); };
    tOpen.onchange = () => { openNowOnly = tOpen.checked; renderAll(); };
  }

  // ---------------------------
  // Map + rendering
  // ---------------------------
  function setupMap() {
    map = L.map("map").setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);

    // Icon check
    const testImg = new Image();
    testImg.onload = () => (markerIcon = new CustomIcon());
    testImg.onerror = () => (markerIcon = new L.Icon.Default());
    testImg.src = "/icons/sunny-32.png";

    map.on("moveend", debouncedLoadVisible);
    map.on("zoomend", debouncedLoadVisible);
  }

  function debouncedLoadVisible() {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(loadVisibleTiles, MOVE_DEBOUNCE_MS);
  }

  async function loadVisibleTiles() {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const bbox = [sw.lat, sw.lng, ne.lat, ne.lng].map(n=>+n.toFixed(5)).join(",");
    const cacheKey = `${TILE_CACHE_PREFIX}${bbox}`;

    const cached = loadLocal(cacheKey, TILE_CACHE_TTL_MS);
    if (cached && Array.isArray(cached)) {
      mergeVenues(cached.map(normalizeElement).filter(Boolean));
      renderAll();
      return;
    }

    try {
      const elements = await fetchOverpass(buildOverpassQuery(bbox));
      saveLocal(cacheKey, elements);
      mergeVenues(elements.map(normalizeElement).filter(Boolean));
      renderAll();
    } catch (e) {
      console.error("Overpass error:", e);
    }
  }

  function venueMatches(v) {
    if (outdoorOnly && !v.hasOutdoor) return false;
    if (openNowOnly && !isOpenNow(v.tags)) return false;
    return true;
  }

  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    const b = map.getBounds();

    Object.values(allVenues).forEach(v => {
      if (!b.contains([v.lat, v.lng])) return;
      if (!venueMatches(v)) return;
      const icon = markerIcon || new L.Icon.Default();
      const marker = L.marker([v.lat, v.lng], { icon }).addTo(markersLayer);
      const tags = v.tags || {};
      const kind = toTitle(tags.amenity || tags.tourism || "");
      const popupHtml = `
        <div class="venue-popup">
          <div class="venue-name"><strong>${v.name}</strong></div>
          ${kind ? `<div>${kind}</div>` : ""}
          ${v.hasOutdoor ? `<div>🌿 Outdoor friendly</div>` : ""}
          ${tags.opening_hours ? `<div>Hours: ${tags.opening_hours}</div>` : ""}
          <div class="links" style="margin-top:6px;">
            <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=">Directions</a>
            <a target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}">Uber</a>
          </div>
          <div class="meta" style="margin-top:6px;">${formatSunInfo(v.lat, v.lng)}</div>
        </div>`;
      marker.bindPopup(popupHtml);
    });
  }

  function renderList() {
    const list = document.getElementById("list");
    if (!list) return;
    const b = map.getBounds();
    const visible = Object.values(allVenues)
      .filter(v => b.contains([v.lat, v.lng]) && venueMatches(v));

    visible.sort((a,b)=> a.name.localeCompare(b.name));

    list.innerHTML = visible.map(v => {
      const tags = v.tags || {};
      const kind = toTitle(tags.amenity || tags.tourism || "");
      const website = tags.website ? `<a target="_blank" rel="noopener" href="${String(tags.website).replace(/^http:\/\//, "https://")}">Website</a>` : "";
      return `
        <div class="card">
          <h3>${v.name} ${v.hasOutdoor ? '<span class="badge">Outdoor</span>' : ''}</h3>
          <div class="meta">${kind}${tags.opening_hours ? " · " + tags.opening_hours : ""}</div>
          <div class="meta">${formatSunInfo(v.lat, v.lng)}</div>
          <div class="links" style="margin-top:6px;">
            <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=">Directions</a>
            <a target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}">Uber</a>
            ${website}
          </div>
        </div>
      `;
    }).join("");
  }

  function renderAll() {
    if (currentView === "map") renderMarkers();
    else renderList();
  }

  // ---------------------------
  // Boot
  // ---------------------------
  function boot() {
    ensureUI();
    const cached = loadLocal(VENUE_CACHE_KEY);
    if (cached && typeof cached === "object") allVenues = cached;
    setupMap();
    renderAll();
    // initial load
    debouncedLoadVisible();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
