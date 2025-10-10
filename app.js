
/* Sunny app.js — Popups Only (build: 2025-10-10-c)
   - Map-only UI (no List view, no bottom chips)
   - Enhanced marker popup "card" with:
     * Sun status badge (☀️ / 🌤️ / ⛅) + azimuth/alt text
     * Open status (Open now / Opening soon / Closing soon / Closed)
     * Distance from current location (if permitted)
     * Buttons: Directions, Uber, Website (if available)
   - Custom pins from icons/marker.png (or window.SUNNY_ICON_URL)
*/
console.log("Sunny app.js loaded: Popups Only 2025-10-10-c");

(function () {
  // ---------------------------
  // Config
  // ---------------------------
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];

  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 };

  const TILE_URL = window.SUNNY_TILE_URL ||
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const TILE_ATTR =
    window.SUNNY_TILE_ATTR ||
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  // Cache
  const VENUE_CACHE_KEY = "sunny-pubs-venues";
  const TILE_CACHE_PREFIX = "sunny-pubs-overpass-tiles-v1:";
  const TILE_CACHE_TTL_MS = 1000 * 60 * 30;

  // State
  let openNowOnly = false;
  let outdoorOnly = false;
  let map, markersLayer;
  let allVenues = {};
  let userLocation = null; // {lat,lng} | false if denied

  // Debounce
  const MOVE_DEBOUNCE_MS = 500;
  let moveTimer = null;

  // Marker icon (forced custom) -> icons/marker.png by default
  const MARKER_ICON_URL = window.SUNNY_ICON_URL || "icons/marker.png";
  const markerIcon = L.icon({
    iconUrl: MARKER_ICON_URL,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28]
  });

  // ---------------------------
  // Helpers
  // ---------------------------
  const $ = (sel) => document.querySelector(sel);
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

  // Distance
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const toRad = (x)=>x*Math.PI/180;
    const dLat = toRad(lat2-lat1);
    const dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  function formatDistanceKm(km) {
    if (km < 1) return `${Math.round(km*1000)} m`;
    return `${km.toFixed(1)} km`;
  }
  function requestUserLocationOnce() {
    if (userLocation !== null) return;
    if (!navigator.geolocation) { userLocation = false; return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      () => { userLocation = false; },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 600000 }
    );
  }

  // Sun utils
  function sunPosition(lat, lng, date = new Date()) {
    const rad = Math.PI/180, deg = 180/Math.PI;
    const J1970 = 2440588, J2000 = 2451545;
    const dayMs = 1000 * 60 * 60 * 24;
    const toJulian = (d) => d / dayMs - 0.5 + J1970;
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
  function sunBadge(lat, lng) {
    const alt = sunPosition(lat, lng).altitudeDeg;
    if (alt >= 45) return { icon: "☀️", label: "Full sun" };
    if (alt >= 15) return { icon: "🌤️", label: "Partial sun" };
    return { icon: "⛅", label: "Low sun" };
  }
  const compass = (a)=>["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

  // Opening hours (light parser)
  const DAY_MAP = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  function parseOpenStatus(openingHours) {
    if (!openingHours) return { status: "Unknown", tone: "muted" };
    const s = String(openingHours).trim();
    if (/24.?7/i.test(s)) return { status: "Open now", tone: "good" };

    const now = new Date();
    const day = DAY_MAP[now.getDay()];
    const rules = s.split(/\s*;\s*/);

    const dayMatches = (rule, d) => {
      rule = rule.replace(/Mon/gi,"Mo").replace(/Tue/gi,"Tu").replace(/Wed/gi,"We").replace(/Thu/gi,"Th").replace(/Fri/gi,"Fr").replace(/Sat/gi,"Sa").replace(/Sun/gi,"Su");
      if (/daily|every ?day|mo-su/i.test(rule)) return true;
      const m = rule.match(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)\b/i);
      if (m){
        const start = DAY_MAP.indexOf(m[1]);
        const end = DAY_MAP.indexOf(m[2]);
        const idx = DAY_MAP.indexOf(d);
        if (start<=end) return idx>=start && idx<=end;
        return idx>=start || idx<=end;
      }
      if (new RegExp(`\\b${d}\\b`, "i").test(rule)) return true;
      return false;
    };

    let todays = null;
    for (const rule of rules) {
      if (dayMatches(rule, day)) { todays = rule; break; }
    }
    if (!todays) todays = s;

    const ranges = [];
    todays.replace(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g, (_, a, b) => { ranges.push([a, b]); return _; });
    if (!ranges.length) return { status: "Unknown", tone: "muted" };

    const nowMin = now.getHours()*60 + now.getMinutes();
    let open = false, minsToOpen = Infinity, minsToClose = Infinity;

    for (const [a,b] of ranges) {
      const [ah,am] = a.split(':').map(Number);
      const [bh,bm] = b.split(':').map(Number);
      let start = ah*60 + am;
      let end = bh*60 + bm;
      if (end < start) end += 24*60; // over midnight
      let current = nowMin;
      if (nowMin < start && end >= 24*60) current += 24*60;

      if (current >= start && current <= end) {
        open = true;
        minsToClose = Math.min(minsToClose, end - current);
      } else if (current < start) {
        minsToOpen = Math.min(minsToOpen, start - current);
      }
    }

    if (open) {
      if (minsToClose <= 60) return { status: "Closing soon", tone: "warn" };
      return { status: "Open now", tone: "good" };
    } else if (isFinite(minsToOpen)) {
      if (minsToOpen <= 60) return { status: "Opening soon", tone: "info" };
      return { status: "Closed", tone: "muted" };
    } else {
      return { status: "Closed", tone: "muted" };
    }
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

        // restaurant with outdoor hints (cafes excluded)
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
  // UI
  // ---------------------------
  function setupMap() {
    if (!document.getElementById("map")) {
      const m = document.createElement("div");
      m.id = "map";
      m.style.position = "absolute";
      m.style.left = "0"; m.style.right = "0";
      m.style.top = "0"; m.style.bottom = "0";
      document.body.appendChild(m);
    }
    map = L.map("map").setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    map.on("moveend", debouncedLoadVisible);
    map.on("zoomend", debouncedLoadVisible);

    // basic filters control (optional)
    const controls = document.createElement("div");
    controls.style.position = "fixed";
    controls.style.right = "16px";
    controls.style.bottom = "16px";
    controls.style.zIndex = 1000;
    controls.innerHTML = `
      <button id="btnFilters" style="background:#111;color:#fff;border:none;border-radius:999px;padding:10px 14px;cursor:pointer">Filters</button>
    `;
    document.body.appendChild(controls);

    const panel = document.createElement("div");
    panel.id = "sunny-filters";
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "64px";
    panel.style.zIndex = 1001;
    panel.style.background = "#fff";
    panel.style.borderRadius = "12px";
    panel.style.boxShadow = "0 10px 30px rgba(0,0,0,.15)";
    panel.style.display = "none";
    panel.innerHTML = `
      <div style="padding:8px 10px;">
        <label><input type="checkbox" id="toggleOutdoor"> Outdoor only</label><br/>
        <label style="margin-top:6px;display:block;"><input type="checkbox" id="toggleOpenNow"> Open now</label>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("btnFilters").onclick = ()=>{
      panel.style.display = (panel.style.display==="none"||!panel.style.display) ? "block":"none";
    };
    document.getElementById("toggleOutdoor").onchange = ()=>{ outdoorOnly = document.getElementById("toggleOutdoor").checked; renderMarkers(); };
    document.getElementById("toggleOpenNow").onchange = ()=>{ openNowOnly = document.getElementById("toggleOpenNow").checked; renderMarkers(); };
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
      renderMarkers();
      return;
    }
    try {
      const elements = await fetchOverpass(buildOverpassQuery(bbox));
      saveLocal(cacheKey, elements);
      mergeVenues(elements.map(normalizeElement).filter(Boolean));
      renderMarkers();
    } catch (e) {
      console.error("Overpass error:", e);
    }
  }

  function isOpenNow(tags) {
    const p = parseOpenStatus(tags && tags.opening_hours);
    return p.status === "Open now" || p.status === "Closing soon";
  }
  function venueMatches(v) {
    if (outdoorOnly && !v.hasOutdoor) return false;
    if (openNowOnly && !isOpenNow(v.tags)) return false;
    return true;
  }

  function popupHTML(v) {
    const tags = v.tags || {};
    const kind = toTitle(tags.amenity || tags.tourism || "");
    const sun = sunBadge(v.lat, v.lng);
    const s = sunPosition(v.lat, v.lng);
    const open = parseOpenStatus(tags.opening_hours);
    const website = (tags.website || tags.contact_website || tags.url) ? String(tags.website || tags.contact_website || tags.url).replace(/^http:\/\//,'https://') : null;
    const distance = userLocation ? formatDistanceKm(haversine(userLocation.lat, userLocation.lng, v.lat, v.lng)) : null;

    return `
      <div style="min-width:220px;max-width:260px">
        <div style="font-weight:800;font-size:16px;line-height:1.1">${v.name}</div>
        ${kind ? `<div style="color:#6b7280;margin:.2rem 0 .4rem 0">${kind}${distance ? ` · ${distance}` : ""}</div>` : (distance?`<div style="color:#6b7280;margin:.2rem 0 .4rem 0">${distance}</div>`:"")}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <span style="display:inline-flex;align-items:center;gap:6px;background:#fff7e6;border:1px solid #fde68a;color:#b45309;border-radius:999px;padding:4px 8px;font-size:12px;">
            <span>${sun.icon}</span><span>${sun.label}</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 8px;font-size:12px;${open.tone==='good'?'background:#e8f7ef;border:1px solid #bbf7d0;color:#166534':open.tone==='warn'?'background:#fff1f2;border:1px solid #fecdd3;color:#9f1239':open.tone==='info'?'background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8':'background:#f3f4f6;border:1px solid #e5e7eb;color:#4b5563'}">
            ${open.status}
          </span>
        </div>
        <div style="color:#6b7280;font-size:12px;margin-bottom:8px">
          Sun now: ${compass(s.azimuthDeg)} (${s.azimuthDeg.toFixed(0)}°) · alt ${s.altitudeDeg.toFixed(0)}°
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=" style="background:#111;color:#fff;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Directions</a>
          <a target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}" style="background:#f1f5f9;color:#111;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Uber</a>
          ${website ? `<a target="_blank" rel="noopener" href="${website}" style="background:#fff;border:1px solid #e5e7eb;color:#0a66c2;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Website</a>` : ""}
        </div>
      </div>
    `;
  }

  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    const b = map.getBounds();
    Object.values(allVenues).forEach(v=>{
      if (!b.contains([v.lat,v.lng])) return;
      if (!venueMatches(v)) return;
      const marker = L.marker([v.lat,v.lng], { icon: markerIcon }).addTo(markersLayer);
      marker.bindPopup(popupHTML(v));
    });
  }

  // ---------------------------
  // Boot
  // ---------------------------
  function boot() {
    // Ask for location once (distance)
    requestUserLocationOnce();

    const cached = loadLocal(VENUE_CACHE_KEY);
    if (cached && typeof cached === "object") allVenues = cached;

    setupMap();
    renderMarkers();
    // initial fetch for tiles
    debouncedLoadVisible();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
