
/* --------------------------------------------------------------------------
   Sunny — app.js (v3 refinement)
   Fixes:
   1) Custom marker icons restored w/ robust fallback and configurable via window.SUNNY_ICON_URL
   2) Reconnect Map/List/Filters to your existing bottom bar buttons (or auto-create)
   3) Bottom bar shows venue count and scrolling chips (or preserves existing)
   4) List cards: larger, styled, with action buttons (+ "Add to crawl")
   5) Ideal time to visit (simple sun-based suggestion)
   6) Cafes removed from query
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

  // Start default (can be overwritten by existing app state)
  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 };

  // Tiles (CartoDB Positron, override via window.SUNNY_TILE_URL)
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
  let currentView = "map";

  // Map + data
  let map, markersLayer;
  let allVenues = {};

  // Debounce
  const MOVE_DEBOUNCE_MS = 500;
  let moveTimer = null;

  // Marker icon
  let markerIcon = null;

  // ---------------------------
  // DOM helpers
  // ---------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function ensureEl(id, html, parent=document.body) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.innerHTML = html || "";
      parent.appendChild(el);
    }
    return el;
  }

  // ---------------------------
  // Storage helpers
  // ---------------------------
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
  // Sun utils (compact)
  // ---------------------------
  function sunPosition(lat, lng, date=new Date()) {
    const rad = Math.PI/180, deg = 180/Math.PI;
    const J1970 = 2440588, J2000 = 2451545;
    const dayMs = 1000 * 60 * 60 * 24;
    const toJulian = (d) => d/ dayMs - 0.5 + J1970;
    const dateToJulian = (date) => toJulian(date.getTime());
    const d = dateToJulian(date) - J2000;

    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148*Math.sin(M) + 0.02*Math.sin(2*M) + 0.0003*Math.sin(3*M));
    const P = rad * 102.9372;
    const L = M + C + P + Math.PI;

    const e = rad * 23.4397;
    const sinDec = Math.sin(e) * Math.sin(L);
    const dec = Math.asin(sinDec);
    const lw = rad * -lng;
    const phi = rad * lat;
    const theta = rad * (280.16 + 360.9856235 * d) - lw;
    const H = theta - L;

    const altitude = Math.asin(Math.sin(phi)*Math.sin(dec) + Math.cos(phi)*Math.cos(dec)*Math.cos(H));
    const azimuth = Math.atan2(Math.sin(H), Math.cos(H)*Math.sin(phi) - Math.tan(dec)*Math.cos(phi));
    return { azimuthDeg: (azimuth*deg + 180) % 360, altitudeDeg: altitude*deg };
  }
  const compass = (a)=>["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];
  const sunNowText = (lat,lng)=>{
    const s = sunPosition(lat,lng,new Date());
    return `Sun now: ${compass(s.azimuthDeg)} (${s.azimuthDeg.toFixed(0)}°), alt ${s.altitudeDeg.toFixed(0)}°`;
  };
  function suggestIdealTime(lat,lng) {
    // Very simple guidance based on current altitude: low -> midday; mid -> afternoon; high -> now
    const alt = sunPosition(lat,lng,new Date()).altitudeDeg;
    if (alt >= 45) return "Ideal: now–2pm (strong sun)";
    if (alt >= 20) return "Ideal: 3–5pm (softer sun)";
    return "Ideal: 12–2pm (more sun)";
    // If you have aspect per venue later, we can refine by azimuth.
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
    return `
      [out:json][timeout:25];
      (
        node["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        way["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        relation["amenity"~"^(pub|bar|biergarten)$"](${bbox});

        // Restaurants with outdoor hints (cafes removed)
        node["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        way["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        relation["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});

        node["amenity"="restaurant"]["garden"="yes"](${bbox});
        way["amenity"="restaurant"]["garden"="yes"](${bbox});
        relation["amenity"="restaurant"]["garden"="yes"](${bbox});

        node["amenity"="restaurant"]["terrace"="yes"](${bbox});
        way["amenity"="restaurant"]["terrace"="yes"](${bbox});
        relation["amenity"="restaurant"]["terrace"="yes"](${bbox});

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
    return { id, name, lat, lng, tags, hasOutdoor: looksOutdoor(tags), source: "osm" };
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
  // Icons
  // ---------------------------
  async function resolveMarkerIcon() {
    const candidates = [
      window.SUNNY_ICON_URL,
      "/icons/sunny-32.png",
      "/icons/sunny-48.png",
      "/icons/sunny-marker.png",
      "/icons/sunny-marker.svg",
    ].filter(Boolean);
    for (const url of candidates) {
      const ok = await testImage(url);
      if (ok) {
        return new (L.Icon.extend({
          options: {
            iconUrl: url, iconSize: [28,28], iconAnchor:[14,28], popupAnchor:[0,-28]
          }
        }))();
      }
    }
    return new L.Icon.Default();
  }
  function testImage(src) {
    return new Promise((resolve)=>{
      const img = new Image();
      img.onload = ()=>resolve(true);
      img.onerror = ()=>resolve(false);
      img.src = src;
    });
  }

  // ---------------------------
  // Bottom bar
  // ---------------------------
  function ensureBottomBar() {
    let bar = document.getElementById("bottomBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "bottomBar";
      bar.style.position = "fixed";
      bar.style.left = "0"; bar.style.right = "0"; bar.style.bottom = "0";
      bar.style.background = "linear-gradient(#fff, #f5f7fa)";
      bar.style.borderTop = "1px solid rgba(0,0,0,.08)";
      bar.style.padding = "10px 12px";
      bar.style.zIndex = 999;
      bar.innerHTML = `<div id="bottomBarContent" style="white-space:nowrap; overflow:auto;"></div>`;
      document.body.appendChild(bar);
    } else if (!document.getElementById("bottomBarContent")) {
      const c = document.createElement("div");
      c.id = "bottomBarContent";
      c.style.whiteSpace = "nowrap"; c.style.overflow = "auto";
      bar.appendChild(c);
    }
  }
  function updateBottomBar(venues) {
    const el = document.getElementById("bottomBarContent");
    if (!el) return;
    if (!venues || !venues.length) {
      el.textContent = "Loading venues...";
      return;
    }
    const chips = venues.slice(0, 30).map(v=>`<span style="display:inline-block;margin-right:8px;background:#eef2f7;border-radius:999px;padding:6px 10px;font-size:12px;">${v.name}</span>`).join("");
    el.innerHTML = `<strong>${venues.length}</strong> venues in view · ${chips}`;
  }

  // ---------------------------
  // List rendering
  // ---------------------------
  function ensureListContainer() {
    if (!document.getElementById("list")) {
      const list = document.createElement("div");
      list.id = "list";
      list.style.position = "absolute";
      list.style.left = "0"; list.style.right = "0"; list.style.top = "0"; list.style.bottom = "56px";
      list.style.background = "#fff";
      list.style.overflow = "auto";
      list.style.display = "none";
      document.body.appendChild(list);
    }
    // Add styles
    if (!document.getElementById("sunny-card-style")) {
      const style = document.createElement("style");
      style.id = "sunny-card-style";
      style.textContent = `
        .card{padding:16px 18px;border-bottom:1px solid #eee}
        .card h3{margin:0 0 8px 0;font-size:18px}
        .pill{display:inline-block;background:#e8f7ef;color:#166534;border-radius:999px;padding:4px 8px;margin-left:6px;font-size:12px}
        .meta{color:#566; font-size:13px;margin:6px 0}
        .btn-row{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
        .btn{background:#111;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
        .btn.secondary{background:#f1f5f9;color:#111}
        .btn.link{background:transparent;color:#0a66c2;text-decoration:underline;padding:0}
      `;
      document.head.appendChild(style);
    }
  }
  function renderList() {
    ensureListContainer();
    const list = document.getElementById("list");
    const b = map.getBounds();
    const visible = Object.values(allVenues).filter(v=>b.contains([v.lat,v.lng]) && venueMatches(v)).sort((a,b)=>a.name.localeCompare(b.name));

    list.innerHTML = visible.map(v=>{
      const tags = v.tags || {};
      const kind = toTitle(tags.amenity || tags.tourism || "");
      const website = tags.website ? `<a class="btn link" target="_blank" rel="noopener" href="${String(tags.website).replace(/^http:\/\//,'https://')}">Website</a>` : "";
      return `
        <div class="card">
          <h3>${v.name} ${v.hasOutdoor ? '<span class="pill">Outdoor</span>' : ''}</h3>
          <div class="meta">${kind}${tags.opening_hours ? " · " + tags.opening_hours : ""}</div>
          <div class="meta">${sunNowText(v.lat,v.lng)} · ${suggestIdealTime(v.lat,v.lng)}</div>
          <div class="btn-row">
            <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=">Directions</a>
            <a class="btn" target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}">Uber</a>
            ${website}
            <button class="btn secondary" data-add-crawl="${v.id}">Add to crawl</button>
          </div>
        </div>
      `;
    }).join("");

    // Wire crawl buttons
    $$("#list [data-add-crawl]").forEach(btn=>{
      btn.onclick = ()=>{
        const id = btn.getAttribute("data-add-crawl");
        const v = allVenues[id];
        if (!v) return;
        const q = loadLocal("sunny-crawl-queue") || [];
        q.push({ id: v.id, name: v.name, lat: v.lat, lng: v.lng, tags: v.tags, ts: Date.now() });
        saveLocal("sunny-crawl-queue", q);
        btn.textContent = "Added ✓";
        btn.disabled = true;
      };
    });
  }

  // ---------------------------
  // Map rendering
  // ---------------------------
  function setupMap() {
    map = L.map("map").setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);

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
    const icon = markerIcon || new L.Icon.Default();

    const visible = [];
    Object.values(allVenues).forEach(v=>{
      if (!b.contains([v.lat,v.lng])) return;
      if (!venueMatches(v)) return;
      visible.push(v);
      const marker = L.marker([v.lat,v.lng], { icon }).addTo(markersLayer);
      const tags = v.tags || {};
      const kind = toTitle(tags.amenity || tags.tourism || "");
      const html = `
        <div class="venue-popup">
          <div class="venue-name"><strong>${v.name}</strong></div>
          ${kind ? `<div>${kind}</div>` : ""}
          ${v.hasOutdoor ? `<div>🌿 Outdoor friendly</div>` : ""}
          ${tags.opening_hours ? `<div>Hours: ${tags.opening_hours}</div>` : ""}
          <div class="links" style="margin-top:6px;">
            <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=">Directions</a>
            <a target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}">Uber</a>
          </div>
          <div class="meta" style="margin-top:6px;">${sunNowText(v.lat,v.lng)} · ${suggestIdealTime(v.lat,v.lng)}</div>
        </div>`;
      marker.bindPopup(html);
    });

    updateBottomBar(visible);
  }

  function renderAll() {
    if (currentView === "map") {
      $("#map").style.display = "block";
      $("#list") && ($("#list").style.display = "none");
      renderMarkers();
    } else {
      $("#map").style.display = "none";
      $("#list").style.display = "block";
      renderList();
    }
  }

  // ---------------------------
  // Wiring existing buttons
  // ---------------------------
  function wireButtons() {
    // Map/List buttons: try multiple selectors
    const mapBtns = [
      "#btnMap", "#mapViewBtn", "[data-role='map']",
      ...$$("button, a").filter(b => /(^|\s)map(\s|$)/i.test(b.textContent.trim()))
    ].map(s=> typeof s==="string" ? $(s) : s).filter(Boolean);
    const listBtns = [
      "#btnList", "#listViewBtn", "[data-role='list']",
      ...$$("button, a").filter(b => /(^|\s)list(\s|$)/i.test(b.textContent.trim()))
    ].map(s=> typeof s==="string" ? $(s) : s).filter(Boolean);
    const filterBtns = [
      "#btnFilters", "#filtersBtn", "[data-role='filters']",
      ...$$("button, a").filter(b => /filter/i.test(b.textContent.trim()))
    ].map(s=> typeof s==="string" ? $(s) : s).filter(Boolean);

    // If none found, create our floating controls
    if (!mapBtns.length && !listBtns.length && !filterBtns.length) {
      const controls = document.createElement("div");
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
      style.textContent = `.sunny-chip{background:#111;color:#fff;border:none;border-radius:999px;padding:10px 14px;cursor:pointer;opacity:.95}.sunny-chip-active{background:#4a4a4a}`;
      document.head.appendChild(style);
      mapBtns.push($("#btnMap"));
      listBtns.push($("#btnList"));
      filterBtns.push($("#btnFilters"));
    }

    // Filters panel
    ensureEl("sunny-filters", `
      <div style="padding:8px 10px;">
        <label><input type="checkbox" id="toggleOutdoor"> Outdoor only</label><br/>
        <label style="margin-top:6px;display:block;"><input type="checkbox" id="toggleOpenNow"> Open now</label>
      </div>
    `);
    const filtersPanel = $("#sunny-filters");
    filtersPanel.style.position = "fixed";
    filtersPanel.style.right = "16px";
    filtersPanel.style.bottom = "72px";
    filtersPanel.style.zIndex = 1001;
    filtersPanel.style.background = "#fff";
    filtersPanel.style.borderRadius = "12px";
    filtersPanel.style.boxShadow = "0 10px 30px rgba(0,0,0,.15)";
    filtersPanel.style.display = "none";

    // Wire clicks
    mapBtns.forEach(btn => btn && (btn.onclick = ()=>{ currentView="map"; renderAll(); }));
    listBtns.forEach(btn => btn && (btn.onclick = ()=>{ currentView="list"; renderAll(); }));
    filterBtns.forEach(btn => btn && (btn.onclick = ()=>{ filtersPanel.style.display = (filtersPanel.style.display==="none"||!filtersPanel.style.display) ? "block":"none"; }));

    // Toggles
    $("#toggleOutdoor").checked = outdoorOnly;
    $("#toggleOpenNow").checked = openNowOnly;
    $("#toggleOutdoor").onchange = ()=>{ outdoorOnly = $("#toggleOutdoor").checked; renderAll(); };
    $("#toggleOpenNow").onchange = ()=>{ openNowOnly = $("#toggleOpenNow").checked; renderAll(); };
  }

  // ---------------------------
  // Boot
  // ---------------------------
  async function boot() {
    // Ensure containers
    if (!$("#map")) {
      const m = document.createElement("div");
      m.id = "map";
      m.style.position = "absolute";
      m.style.left = "0"; m.style.right = "0"; m.style.top = "0"; m.style.bottom = "56px";
      document.body.appendChild(m);
    }
    ensureBottomBar();
    wireButtons();

    // Load cache
    const cached = loadLocal(VENUE_CACHE_KEY);
    if (cached && typeof cached === "object") allVenues = cached;

    // Map
    setupMap();

    // Marker icon (async)
    markerIcon = await resolveMarkerIcon();

    // Initial render & load
    renderAll();
    debouncedLoadVisible();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
