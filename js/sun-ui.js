/*
  Sunny — sun-ui.js  (behind the `sun` feature flag; loaded only when it's on)

  Live sun / shade / cloud pins, hour chips to look ahead, and a sun line on the
  venue card. The chips show only where a city has sun data (CITIES below); everywhere
  else gets a closable "coming soon" message. Uses only Sunny's own data (venue_sun_profile, venue_seating —
  derived from OpenStreetMap and the 2015 Dublin LiDAR) plus Open-Meteo weather.
  No Google Places calls; Google's map is only the base layer.

  Hooks called from app.js (all optional-chained, so app.js works without this):
    SunnySunUI.onVenuesVisible(venues, center)  after the visible set is computed
                                                (center: { lat, lng } of the map)
    SunnySunUI.decorateMarker(marker, v) after a marker is created/updated
    SunnySunUI.renderCard(cardEl, v)     when a venue card opens
*/
(function () {
  "use strict";
  const S = window.SunnySun;
  if (!S) return;

  const SUPABASE_URL = "https://ivylljoqjswkuyrpevmg.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2eWxsam9xanN3a3V5cnBldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTk4NzksImV4cCI6MjA4OTQ3NTg3OX0.nyRzoYBdJeMg2CR45WRR7bDMkHSi524z_dLfASIBczs";
  const CITY_TZ = { Dublin: "Europe/Dublin", London: "Europe/London" };
  // Cities with live sun mapping. bbox [south, west, north, east] and origin mirror tools/sun/cities/<city>.json.
  const CITIES = { Dublin: { tz: "Europe/Dublin", bbox: [53.20, -6.50, 53.48, -6.00], origin: [53.3438, -6.2546] } };
  const TIP_SEEN_KEY = "sunny_sun_tip_seen";
  const SOON_DISMISSED_KEY = "sunny_sun_soon_dismissed";
  const PROFILE_CACHE_KEY = "sunny-sun-profile-v1";
  const PROFILE_CACHE_MAX = 600;
  const PROFILE_TTL_MS = 1000 * 60 * 60 * 12;
  const PROFILE_MISS_TTL_MS = 1000 * 60 * 60 * 2;
  const WEATHER_CACHE_KEY = "sunny-sun-weather-v1";
  const WEATHER_CACHE_MAX = 40;
  const WEATHER_TTL_MS = 1000 * 60 * 30;
  const WEATHER_GRID_DEG = 0.05; // same grid as the viewport cache
  const STEP_MIN = 10;
  const ATTRIBUTION = 'Sun estimate © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' +
    ' · LiDAR © Laefer et al., NYU (2015), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>' +
    ' · Weather by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>';

  // ── Analytics (existing pipeline: Supabase events + GA4 via SunnyAnalytics) ──
  function track(name, params) {
    try { window.SunnyAnalytics?.track?.(name, params || {}); } catch { /* no-op */ }
  }

  // ── Small sessionStorage LRU, same spirit as the viewport cache ────────────
  function lruLoad(key) {
    try { return new Map(JSON.parse(sessionStorage.getItem(key) || "[]")); } catch { return new Map(); }
  }
  function lruSave(key, map, max) {
    try {
      const entries = Array.from(map.entries());
      sessionStorage.setItem(key, JSON.stringify(entries.slice(Math.max(0, entries.length - max))));
    } catch { /* quota or private mode */ }
  }
  function lruGet(map, k, ttl) {
    const e = map.get(k);
    if (!e) return undefined;
    if (Date.now() - e.t > ttl) { map.delete(k); return undefined; }
    map.delete(k); map.set(k, e); // refresh recency
    return e.v;
  }

  const profileCache = lruLoad(PROFILE_CACHE_KEY);
  const weatherCache = lruLoad(WEATHER_CACHE_KEY);

  let sb = null;
  function supabase() {
    if (sb) return sb;
    if (!window.supabase?.createClient) return null;
    try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch { return null; }
    return sb;
  }

  // ── Profiles ───────────────────────────────────────────────────────────────
  // venue id -> { horizon(Float32Array), lat, lng, tz, label, quality, type } | null
  const profiles = new Map();
  const inflight = new Set();

  function hydrate(raw) {
    if (!raw) return null;
    const horizon = S.decodeHorizon(raw.h);
    if (!horizon) return null;
    if (CITY_TZ[raw.city]) displayTz = CITY_TZ[raw.city];
    return {
      horizon, lat: raw.lat, lng: raw.lng, tz: CITY_TZ[raw.city] || undefined,
      label: raw.src === "venue" ? "Venue-verified" : "Estimated",
      quality: raw.q, type: raw.type,
    };
  }

  async function fetchProfiles(ids) {
    const want = [];
    ids.forEach((id) => {
      if (profiles.has(id) || inflight.has(id)) return;
      const cached = lruGet(profileCache, id, PROFILE_TTL_MS);
      if (cached !== undefined) {
        if (cached === null) {
          const e = profileCache.get(id);
          if (e && Date.now() - e.t < PROFILE_MISS_TTL_MS) { profiles.set(id, null); return; }
        } else { profiles.set(id, hydrate(cached)); return; }
      }
      want.push(id);
    });
    if (!want.length) return false;
    const client = supabase();
    if (!client) return false;
    want.forEach((id) => inflight.add(id));
    try {
      for (let i = 0; i < want.length; i += 100) {
        const chunk = want.slice(i, i + 100);
        const [p, s] = await Promise.all([
          client.from("venue_sun_profile").select("place_id,city,horizon,data_quality").in("place_id", chunk),
          client.from("venue_seating").select("place_id,seating_lat,seating_lng,seating_source,seating_type").in("place_id", chunk),
        ]);
        if (p.error || s.error) throw p.error || s.error;
        const seat = new Map((s.data || []).map((r) => [r.place_id, r]));
        const got = new Set();
        (p.data || []).forEach((r) => {
          const st = seat.get(r.place_id);
          if (!st) return;
          const raw = { h: r.horizon, lat: st.seating_lat, lng: st.seating_lng, city: r.city,
            src: st.seating_source, type: st.seating_type, q: Number(r.data_quality) };
          got.add(r.place_id);
          profileCache.set(r.place_id, { v: raw, t: Date.now() });
          profiles.set(r.place_id, hydrate(raw));
        });
        chunk.forEach((id) => {
          if (got.has(id)) return;
          profileCache.set(id, { v: null, t: Date.now() });
          profiles.set(id, null); // no profile: show no sun state rather than a guess
        });
      }
      lruSave(PROFILE_CACHE_KEY, profileCache, PROFILE_CACHE_MAX);
      return true;
    } catch (e) {
      console.warn("[Sunny Sun] profile fetch failed", e?.message || e);
      return false;
    } finally {
      want.forEach((id) => inflight.delete(id));
    }
  }

  // ── Weather (Open-Meteo, one request per 0.05° cell, cached) ───────────────
  const weatherInflight = new Map();
  function cellKey(lat, lng) {
    const r = (v) => (Math.round(v / WEATHER_GRID_DEG) * WEATHER_GRID_DEG).toFixed(2);
    return `${r(lat)},${r(lng)}`;
  }
  function weatherFor(lat, lng) {
    const key = cellKey(lat, lng);
    const cached = lruGet(weatherCache, key, WEATHER_TTL_MS);
    if (cached !== undefined) return Promise.resolve(cached);
    if (weatherInflight.has(key)) return weatherInflight.get(key);
    const [clat, clng] = key.split(",");
    const params = new URLSearchParams({
      latitude: clat, longitude: clng, timezone: "UTC", forecast_days: "2",
      hourly: "cloud_cover,direct_normal_irradiance",
    });
    const p = fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const h = j && j.hourly;
        const v = h ? { t0: Date.parse(`${h.time[0]}Z`), cc: h.cloud_cover, dni: h.direct_normal_irradiance } : null;
        weatherCache.set(key, { v, t: Date.now() });
        lruSave(WEATHER_CACHE_KEY, weatherCache, WEATHER_CACHE_MAX);
        return v;
      })
      .catch((e) => { console.warn("[Sunny Sun] weather fetch failed", e?.message || e); return null; })
      .finally(() => weatherInflight.delete(key));
    weatherInflight.set(key, p);
    return p;
  }
  function weatherAt(w, ms) {
    if (!w) return {};
    const hrs = (ms - w.t0) / 3600000;
    const i = Math.floor(hrs);
    if (i < 0 || i + 1 >= w.cc.length) return {};
    const f = hrs - i;
    // cloud_cover is instantaneous at the hour; DNI is the preceding-hour mean
    const cc = w.cc[i] * (1 - f) + w.cc[i + 1] * f;
    const dni = w.dni[Math.ceil(hrs)];
    return { cloudCover: cc, dni: typeof dni === "number" ? dni : null };
  }
  function weatherSync(lat, lng) {
    return lruGet(weatherCache, cellKey(lat, lng), WEATHER_TTL_MS) ?? null;
  }

  // ── Time (hour chips: now, or a chosen hour today / tomorrow) ─────────────
  // Times are shown in the venues' city time zone (not the device's), so a
  // visitor whose phone is on another zone still sees Dublin times.
  let selectedAt = null; // null = now, else the UTC ms of the chosen hour
  let displayTz;
  function selectedMs() { return selectedAt ?? Date.now(); }
  function offsetMin() { return selectedAt ? Math.round((selectedAt - Date.now()) / 60000) : 0; }

  // ── State per venue ───────────────────────────────────────────────────────
  const timelines = new Map(); // id -> { day, tl }
  function stateFor(id, ms) {
    const p = profiles.get(id);
    if (!p) return null;
    const sun = S.sunPosition(ms, p.lat, p.lng);
    const wx = weatherAt(weatherSync(p.lat, p.lng), ms);
    const cloudy = S.isCloudy({ ...wx, sunAltitudeDeg: sun.altitudeDeg });
    return S.sunState(p.horizon, p.lat, p.lng, ms, { cloudy });
  }
  function timelineFor(id, ms) {
    const p = profiles.get(id);
    if (!p) return null;
    const day = S.startOfLocalDay(ms, p.tz || Intl.DateTimeFormat().resolvedOptions().timeZone);
    const c = timelines.get(id);
    if (c && c.day === day) return c.tl;
    const tl = S.dayTimeline(p.horizon, p.lat, p.lng, ms, { timeZone: p.tz, stepMin: STEP_MIN });
    timelines.set(id, { day, tl });
    return tl;
  }

  // ── Pins ──────────────────────────────────────────────────────────────────
  const PIN = "M18 46C18 46 3 28.5 3 17.5a15 15 0 1 1 30 0C33 28.5 18 46 18 46z";
  // Every sun pin is a coloured pin with a white disc and a glyph in the pin's colour:
  // gold + sun (in sun), teal + parasol (in shade), blue + cloud (sun hidden by cloud),
  // Sunny orange + pint glass (no sun data for this venue yet, inside a sun-mapped city —
  // says "pub" and nothing about sun, unlike the default pin's sunburst).
  const DISC = '<circle cx="18" cy="17" r="10.5" fill="#fff"/>';
  const GLYPH = {
    sun: DISC + '<circle cx="18" cy="17" r="3.6" fill="#f58a00"/><path d="M18 9.5v2M18 22.5v2M10.5 17h2M23.5 17h2M12.7 11.7l1.4 1.4M21.9 20.9l1.4 1.4' +
      'M12.7 22.3l1.4-1.4M21.9 13.1l1.4-1.4" stroke="#f58a00" stroke-width="2" stroke-linecap="round" fill="none"/>',
    shade: DISC + '<path d="M10.5 17a7.5 7.5 0 0 1 15 0z" fill="#0b7f8b"/>' +
      '<path d="M18 17v5.2a1.6 1.6 0 0 0 3.2 0" stroke="#0b7f8b" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
    cloud: DISC + '<path d="M12.6 21.2h10.2a3.6 3.6 0 0 0 .3-7.2 4.8 4.8 0 0 0-9.1 1.3 3 3 0 0 0-1.4 5.9z" fill="#3f6fd1"/>',
    none: DISC + '<path d="M13.6 10.5h8.8l-1.1 13h-6.6z" fill="#e65f00"/><path d="M13.6 10.5h8.8l-.3 3.4h-8.2z" fill="#ffd2ad"/>',
  };
  const FILL = { sun: "#ffb400", shade: "#0f9aa8", cloud: "#5b8def", none: "#ff6a00" };
  const icons = {};
  function iconFor(state) {
    if (!GLYPH[state] || !window.google?.maps) return null;
    if (!icons[state]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="47" viewBox="0 0 36 47"><path d="${PIN}" fill="${FILL[state]}" stroke="#fff" stroke-width="2"/>${GLYPH[state]}</svg>`;
      icons[state] = {
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
        scaledSize: new google.maps.Size(36, 47), anchor: new google.maps.Point(18, 47),
      };
    }
    return icons[state];
  }

  const markers = new Map(); // id -> marker
  function isSunIcon(icon) { return !!icon && Object.values(icons).includes(icon); }
  function applyMarker(id, marker, ms) {
    const st = stateFor(id, ms);
    let icon = st ? iconFor(st.state) : null; // night: the default pin
    if (!st && profiles.get(id) === null && marker.__sunnyCity) {
      // In a sun-mapped city but no data for this venue: neutral pin while the sun is up.
      const c = CITIES[marker.__sunnyCity];
      if (S.sunPosition(ms, c.origin[0], c.origin[1]).altitudeDeg > 0) icon = iconFor("none");
    }
    const cur = marker.getIcon();
    if (!isSunIcon(cur)) marker.__sunnyBaseIcon = cur;
    if (icon) {
      if (cur !== icon) marker.setIcon(icon);
    } else if (isSunIcon(cur)) {
      marker.setIcon(marker.__sunnyBaseIcon ?? null); // was sun/shade, now night: back to the default pin
    }
    marker.__sunnySunState = st ? st.state : "none";
  }

  function decorateMarker(marker, v) {
    if (!marker || !v) return;
    markers.set(v.id, marker);
    marker.__sunnyCity = cityAt(v) || null;
    applyMarker(v.id, marker, selectedMs());
  }

  let pinEventTimer = null;
  let lastPinSig = "";
  function reportPins(visibleIds) {
    clearTimeout(pinEventTimer);
    pinEventTimer = setTimeout(() => {
      const counts = { sun: 0, shade: 0, cloud: 0, night: 0, none: 0 };
      visibleIds.forEach((id) => {
        const m = markers.get(id);
        const s = m && m.__sunnySunState;
        counts[s && counts[s] !== undefined ? s : "none"]++;
      });
      const shown = counts.sun + counts.shade + counts.cloud;
      const sig = JSON.stringify(counts) + (selectedAt || 0);
      if (!shown || sig === lastPinSig) return;
      lastPinSig = sig;
      track("sun_pins_rendered", { ...counts, time_offset_min: offsetMin() });
    }, 1500);
  }

  let lastVisible = [];
  async function onVenuesVisible(venues, center) {
    lastVisible = (venues || []).map((v) => v.id);
    ensureControls();
    if (controls) controls.setPlace(center || centroid(venues));
    const fetched = await fetchProfiles(lastVisible);
    if (controls) controls.sync();
    const cells = new Map();
    lastVisible.forEach((id) => {
      const p = profiles.get(id);
      if (p) cells.set(cellKey(p.lat, p.lng), p);
    });
    await Promise.all(Array.from(cells.values()).map((p) => weatherFor(p.lat, p.lng)));
    refresh({ pins: true });
    reportPins(lastVisible);
    return fetched;
  }

  // ── Venue card ────────────────────────────────────────────────────────────
  let cardRef = null;
  function renderCard(cardEl, v) {
    if (!cardEl || !v) return;
    cardRef = { el: cardEl, v };
    const go = () => {
      let box = cardEl.querySelector(".venue-card__sun");
      const p = profiles.get(v.id);
      if (!p) { if (box) box.remove(); return; }
      if (!box) {
        box = document.createElement("div");
        box.className = "venue-card__sun";
        const anchor = cardEl.querySelector(".venue-card__badges");
        if (anchor) anchor.insertAdjacentElement("afterend", box); else cardEl.appendChild(box);
      }
      const ms = selectedMs();
      const st = stateFor(v.id, ms);
      const tl = timelineFor(v.id, ms);
      const line = S.sunLine(tl, ms, p.tz, st.state);
      const icon = { sun: "☀️", shade: "⛱️", cloud: "☁️", night: "🌙" }[st.state] || "";
      const tz = p.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const otherDay = selectedAt && S.startOfLocalDay(ms, tz) !== S.startOfLocalDay(Date.now(), tz);
      const when = selectedAt ? ` <span class="venue-card__sun-when">${otherDay ? "tomorrow " : ""}at ${S.formatClock(ms, p.tz)}</span>` : "";
      box.innerHTML = `<div class="venue-card__sun-line"><span class="venue-card__sun-icon" aria-hidden="true">${icon}</span>` +
        `<span class="venue-card__sun-text"></span>${when}<span class="venue-card__sun-label"></span></div>` +
        `<div class="venue-card__sun-attrib">${ATTRIBUTION}</div>`;
      box.querySelector(".venue-card__sun-text").textContent = line;
      box.querySelector(".venue-card__sun-label").textContent = p.label;
      box.dataset.state = st.state;
      if (box.__trackedFor !== v.id) {
        box.__trackedFor = v.id;
        track("sun_line_view", { place_id: v.id, state: st.state, label: p.label,
          data_quality: p.quality, seating_type: p.type, time_offset_min: offsetMin() });
      }
    };
    if (profiles.has(v.id)) { go(); return; }
    fetchProfiles([v.id]).then(() => {
      const p = profiles.get(v.id);
      return p ? weatherFor(p.lat, p.lng) : null;
    }).then(() => { if (cardRef && cardRef.v.id === v.id) go(); });
  }

  // ── Time chips, one-off tip, "coming soon" message ─────────────────────────
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* private mode */ }
    return null;
  }
  function centroid(venues) {
    const pts = (venues || []).filter((v) => v && typeof v.lat === "number" && typeof v.lng === "number");
    if (!pts.length) return null;
    return { lat: pts.reduce((a, v) => a + v.lat, 0) / pts.length, lng: pts.reduce((a, v) => a + v.lng, 0) / pts.length };
  }
  function cityAt(place) {
    if (!place) return undefined; // unknown: leave things as they are
    return Object.keys(CITIES).find((name) => S.inBbox(place.lat, place.lng, CITIES[name].bbox)) || null;
  }
  function hourLabel(ms, tz) {
    const h = S.zonedParts(ms, tz).h;
    return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
  }
  const SUN_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>';

  let controls = null;
  function ensureControls() {
    if (controls || !document.body) return;
    const style = document.createElement("style");
    style.textContent = `
      .sun-bar{position:fixed;left:0;right:0;top:56px;z-index:900;pointer-events:none;
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111}
      .sun-bar>*{pointer-events:auto}
      .sun-bar [hidden]{display:none!important}
      .sun-chips{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
      .sun-chips::-webkit-scrollbar{display:none}
      .sun-chip,.sun-chips__day{flex:none;height:44px;box-sizing:border-box;border-radius:999px;display:inline-flex;align-items:center;gap:6px;
        padding:0 16px;font-family:inherit;font-size:15px;font-weight:700;line-height:1;white-space:nowrap}
      .sun-chip{border:1px solid #d9dde1;background:#fff;color:#111;box-shadow:0 1px 5px rgba(0,0,0,.2);cursor:pointer;-webkit-tap-highlight-color:transparent}
      .sun-chip[aria-pressed=true]{background:#111;border-color:#111;color:#fff}
      .sun-chip:focus-visible,.sun-tip__ok:focus-visible,.sun-soon__close:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
      .sun-chips__day{padding:0 12px 0 14px;background:rgba(17,17,17,.82);color:#fff;font-weight:600}
      .sun-tip{position:relative;margin:2px 12px 0;max-width:340px;background:#111;color:#fff;border-radius:14px;padding:12px 14px;
        box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:14px;line-height:1.4}
      .sun-tip::before{content:"";position:absolute;top:-6px;left:30px;width:12px;height:12px;background:#111;transform:rotate(45deg)}
      .sun-tip__title{font-weight:800;display:block;margin-bottom:2px}
      .sun-tip__row{display:flex;align-items:flex-end;gap:12px}
      .sun-tip__text{flex:1;margin:0}
      .sun-tip__ok{flex:none;height:44px;padding:0 16px;border-radius:999px;border:0;background:#fff;color:#111;font-family:inherit;font-size:14px;font-weight:700;line-height:1;cursor:pointer}
      .sun-soon{display:flex;align-items:center;gap:8px;margin:10px 12px 0;width:fit-content;max-width:calc(100% - 24px);box-sizing:border-box;
        background:#fff;border:1px solid #d9dde1;border-radius:14px;padding:4px 4px 4px 14px;box-shadow:0 1px 5px rgba(0,0,0,.2);font-size:14px;font-weight:600;line-height:1.3}
      .sun-soon svg{flex:none;color:#b45309}
      .sun-soon__close{flex:none;width:44px;height:44px;border:0;background:transparent;color:#111;border-radius:999px;cursor:pointer;
        display:inline-flex;align-items:center;justify-content:center;padding:0}
      body.sun-bar-on .venue-status{top:calc(56px + 70px)}
      body.sun-bar-on .live-crawl-banner{top:126px}
      body.sun-bar-on #venue-count-toast{top:70px!important}
      body.sun-bar-on #map .gm-style-mtc-bbw,body.sun-bar-on #map .gm-fullscreen-control{margin-top:70px!important}
      .venue-card__sun-attrib{font-size:.68rem;color:#666;line-height:1.3}
      .venue-card__sun-attrib a{color:inherit}
      .venue-card__sun{margin:.4rem 0 .2rem;padding:.5rem .6rem;border-radius:10px;background:#fff8e6}
      .venue-card__sun[data-state=shade]{background:#e6f6f7}.venue-card__sun[data-state=cloud]{background:#edf3fd}
      .venue-card__sun[data-state=night]{background:#eef0f7}
      .venue-card__sun-line{display:flex;align-items:center;gap:.4rem;font-weight:600;flex-wrap:wrap}
      .venue-card__sun-when{font-weight:400;color:#555}
      .venue-card__sun-label{margin-left:auto;font-size:.72rem;font-weight:600;color:#555;border:1px solid #ccc;border-radius:999px;padding:1px 7px}
    `;
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.className = "sun-bar";
    el.innerHTML =
      `<div class="sun-chips" role="group" aria-label="Show sun and shade at" hidden></div>` +
      `<div class="sun-tip" role="status" hidden><div class="sun-tip__row"><p class="sun-tip__text">` +
        `<span class="sun-tip__title">New in Dublin: live sun mapping</span>` +
        `Gold pins are in sun, teal in shade, blue under cloud. Pint pins have no sun data yet. Tap a time to look ahead. Estimates only.</p>` +
        `<button type="button" class="sun-tip__ok">Got it</button></div></div>` +
      `<div class="sun-soon" role="status" hidden>${SUN_SVG}<span>Live sun mapping coming soon for this location</span>` +
        `<button type="button" class="sun-soon__close" aria-label="Close"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" ` +
        `stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    document.body.appendChild(el);
    const chipsEl = el.querySelector(".sun-chips");
    const tipEl = el.querySelector(".sun-tip");
    const soonEl = el.querySelector(".sun-soon");

    let city; // undefined = not known yet, null = no sun mapping here, else a CITIES key
    let listSig = "";
    let soonTracked = false;

    const closeTip = (how) => {
      if (tipEl.hidden) return;
      tipEl.hidden = true;
      track("sun_tip_dismissed", { how });
    };
    const sync = () => {
      const c = city ? CITIES[city] : null;
      if (c) {
        const now = Date.now();
        const sunUp = S.sunPosition(now, c.origin[0], c.origin[1]).altitudeDeg > 0;
        const { hours, isTomorrow } = S.daylightHours(now, c.origin[0], c.origin[1], c.tz);
        if (selectedAt && !hours.includes(selectedAt)) selectedAt = null; // the chosen hour has passed
        const sig = [city, sunUp, isTomorrow, hours[0], hours.length].join("|");
        if (sig !== listSig) {
          listSig = sig;
          chipsEl.innerHTML =
            (sunUp ? `<button type="button" class="sun-chip" data-t="now">${SUN_SVG}Now</button>`
              : `<span class="sun-chips__day">${isTomorrow ? "Tomorrow" : "Today"}</span>`) +
            hours.map((t) => `<button type="button" class="sun-chip" data-t="${t}">${hourLabel(t, c.tz)}</button>`).join("");
          chipsEl.scrollLeft = 0;
        }
        chipsEl.querySelectorAll(".sun-chip").forEach((b) => {
          const on = b.dataset.t === "now" ? !selectedAt : Number(b.dataset.t) === selectedAt;
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        if (chipsEl.hidden && !store(TIP_SEEN_KEY)) {
          store(TIP_SEEN_KEY, "1"); // shown once per device, whether or not it's dismissed
          tipEl.hidden = false;
          track("sun_tip_shown", { city });
        }
      } else if (!tipEl.hidden) {
        tipEl.hidden = true;
      }
      chipsEl.hidden = !c;
      soonEl.hidden = !(city === null && !store(SOON_DISMISSED_KEY));
      if (!soonEl.hidden && !soonTracked) { soonTracked = true; track("sun_soon_shown"); }
      document.body.classList.toggle("sun-bar-on", !chipsEl.hidden || !soonEl.hidden);
    };
    const setPlace = (place) => {
      const next = cityAt(place);
      if (next === undefined || next === city) return;
      city = next;
      if (!city && selectedAt) { selectedAt = null; refresh({ pins: true, card: true }); }
      sync();
    };

    chipsEl.addEventListener("click", (e) => {
      const b = e.target.closest(".sun-chip");
      if (!b) return;
      const t = b.dataset.t === "now" ? null : Number(b.dataset.t);
      selectedAt = t === selectedAt ? null : t; // tapping the chosen hour again goes back to now
      closeTip("chip");
      sync();
      refresh({ pins: true, card: true });
      track("sun_time_changed", { time_offset_min: offsetMin() });
    });
    tipEl.querySelector(".sun-tip__ok").addEventListener("click", () => closeTip("button"));
    soonEl.querySelector(".sun-soon__close").addEventListener("click", () => {
      store(SOON_DISMISSED_KEY, "1");
      sync();
      track("sun_soon_dismissed");
    });
    setInterval(() => { sync(); refresh({ pins: true, card: true }); }, 60000);
    controls = { el, sync, setPlace };
    sync();
  }

  function refresh({ pins = false, card = false } = {}) {
    const ms = selectedMs();
    if (pins) markers.forEach((m, id) => { if (profiles.has(id)) applyMarker(id, m, ms); });
    if (card && cardRef && cardRef.el.isConnected && cardRef.el.dataset.venueId === String(cardRef.v.id)) renderCard(cardRef.el, cardRef.v);
  }

  window.SunnySunUI = { onVenuesVisible, decorateMarker, renderCard, _debug: { profiles, stateFor, timelineFor } };
})();
