/*
  Sunny — sun-ui.js  (behind the `sun` feature flag; loaded only when it's on)

  Live sun / shade / cloud pins, a time slider for today, and a sun line on the
  venue card. Uses only Sunny's own data (venue_sun_profile, venue_seating —
  derived from OpenStreetMap and the 2015 Dublin LiDAR) plus Open-Meteo weather.
  No Google Places calls; Google's map is only the base layer.

  Hooks called from app.js (all optional-chained, so app.js works without this):
    SunnySunUI.onVenuesVisible(venues)   after the visible set is computed
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

  // ── Time (slider offset from now, today only) ─────────────────────────────
  let offsetMin = 0;
  function selectedMs() { return Date.now() + offsetMin * 60000; }

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
  const GLYPH = {
    sun: '<circle cx="18" cy="17" r="6" fill="#fff6c2"/><g stroke="#fff6c2" stroke-width="2" stroke-linecap="round">' +
      [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = Math.PI * a / 180, x1 = 18 + 8.5 * Math.cos(r), y1 = 17 + 8.5 * Math.sin(r), x2 = 18 + 11 * Math.cos(r), y2 = 17 + 11 * Math.sin(r);
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      }).join("") + "</g>",
    shade: '<circle cx="18" cy="17" r="7" fill="none" stroke="#e6ebf0" stroke-width="2"/><path d="M18 10a7 7 0 0 1 0 14z" fill="#e6ebf0"/>',
    cloud: '<path d="M11.5 22h13a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.4 1.6A3.8 3.8 0 0 0 11.5 22z" fill="#fff"/>',
  };
  const FILL = { sun: "#f29d00", shade: "#4f5d6b", cloud: "#8a96a3" };
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
  function applyMarker(id, marker, ms) {
    const st = stateFor(id, ms);
    const icon = st ? iconFor(st.state) : null; // night / no profile: leave the default pin
    if (icon) {
      if (marker.getIcon() !== icon) marker.setIcon(icon);
      marker.__sunnySunState = st.state;
    } else {
      marker.__sunnySunState = st ? st.state : "none";
    }
  }

  function decorateMarker(marker, v) {
    if (!marker || !v) return;
    markers.set(v.id, marker);
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
      const sig = JSON.stringify(counts) + offsetMin;
      if (!shown || sig === lastPinSig) return;
      lastPinSig = sig;
      track("sun_pins_rendered", { ...counts, time_offset_min: offsetMin });
    }, 1500);
  }

  let lastVisible = [];
  async function onVenuesVisible(venues) {
    lastVisible = (venues || []).map((v) => v.id);
    ensureControls();
    const fetched = await fetchProfiles(lastVisible);
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
      const icon = { sun: "☀️", shade: "🌥️", cloud: "☁️", night: "🌙" }[st.state] || "";
      const when = offsetMin ? ` <span class="venue-card__sun-when">at ${S.formatClock(ms, p.tz)}</span>` : "";
      box.innerHTML = `<div class="venue-card__sun-line"><span class="venue-card__sun-icon" aria-hidden="true">${icon}</span>` +
        `<span class="venue-card__sun-text"></span>${when}<span class="venue-card__sun-label"></span></div>` +
        `<div class="venue-card__sun-attrib">${ATTRIBUTION}</div>`;
      box.querySelector(".venue-card__sun-text").textContent = line;
      box.querySelector(".venue-card__sun-label").textContent = p.label;
      box.dataset.state = st.state;
      if (box.__trackedFor !== v.id) {
        box.__trackedFor = v.id;
        track("sun_line_view", { place_id: v.id, state: st.state, label: p.label,
          data_quality: p.quality, seating_type: p.type, time_offset_min: offsetMin });
      }
    };
    if (profiles.has(v.id)) { go(); return; }
    fetchProfiles([v.id]).then(() => {
      const p = profiles.get(v.id);
      return p ? weatherFor(p.lat, p.lng) : null;
    }).then(() => { if (cardRef && cardRef.v.id === v.id) go(); });
  }

  // ── Time slider ───────────────────────────────────────────────────────────
  let controls = null;
  function minutesLeftToday() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const end = S.startOfLocalDay(Date.now() + 36 * 3600000, tz) - 1;
    const endOfToday = Math.min(end, S.startOfLocalDay(Date.now(), tz) + 24 * 3600000 - 1);
    return Math.max(0, Math.floor((endOfToday - Date.now()) / 60000 / STEP_MIN) * STEP_MIN);
  }
  function ensureControls() {
    if (controls || !document.body) return;
    const style = document.createElement("style");
    style.textContent = `
      .sun-time{position:fixed;left:12px;bottom:28px;z-index:900;background:#fff;color:#111;border-radius:12px;
        box-shadow:0 2px 10px rgba(0,0,0,.18);padding:8px 12px 6px;width:min(320px,calc(100vw - 24px));font-size:.85rem}
      .sun-time__row{display:flex;align-items:center;gap:.5rem}
      .sun-time__label{font-weight:700;white-space:nowrap}
      .sun-time__now{margin-left:auto;border:1px solid #ddd;background:#fafafa;border-radius:8px;padding:2px 8px;font-size:.8rem}
      .sun-time input[type=range]{width:100%;accent-color:#f29d00}
      .sun-time__attrib,.venue-card__sun-attrib{font-size:.68rem;color:#666;line-height:1.3}
      .sun-time__attrib a,.venue-card__sun-attrib a{color:inherit}
      .venue-card__sun{margin:.4rem 0 .2rem;padding:.5rem .6rem;border-radius:10px;background:#fff8e6}
      .venue-card__sun[data-state=shade]{background:#eef1f4}.venue-card__sun[data-state=cloud]{background:#f1f3f5}
      .venue-card__sun[data-state=night]{background:#eef0f7}
      .venue-card__sun-line{display:flex;align-items:center;gap:.4rem;font-weight:600;flex-wrap:wrap}
      .venue-card__sun-when{font-weight:400;color:#555}
      .venue-card__sun-label{margin-left:auto;font-size:.72rem;font-weight:600;color:#555;border:1px solid #ccc;border-radius:999px;padding:1px 7px}
    `;
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.className = "sun-time";
    el.innerHTML = `<div class="sun-time__row"><span aria-hidden="true">☀️</span><span class="sun-time__label">Sun now</span>` +
      `<button type="button" class="sun-time__now" hidden>Back to now</button></div>` +
      `<input type="range" min="0" step="${STEP_MIN}" value="0" aria-label="Show sun and shade at a later time today">` +
      `<div class="sun-time__attrib">${ATTRIBUTION}</div>`;
    document.body.appendChild(el);
    const range = el.querySelector("input");
    const label = el.querySelector(".sun-time__label");
    const nowBtn = el.querySelector(".sun-time__now");
    const sync = () => {
      range.max = String(minutesLeftToday());
      if (offsetMin > Number(range.max)) offsetMin = Number(range.max);
      range.value = String(offsetMin);
      label.textContent = offsetMin ? `Sun at ${S.formatClock(selectedMs(), undefined, { roundMin: STEP_MIN })}` : "Sun now";
      nowBtn.hidden = !offsetMin;
    };
    let trackTimer = null;
    range.addEventListener("input", () => {
      offsetMin = Number(range.value) || 0;
      sync();
      refresh({ pins: true, card: true });
      clearTimeout(trackTimer);
      trackTimer = setTimeout(() => track("sun_time_changed", { time_offset_min: offsetMin }), 1000);
    });
    nowBtn.addEventListener("click", () => {
      offsetMin = 0; sync(); refresh({ pins: true, card: true });
      track("sun_time_changed", { time_offset_min: 0 });
    });
    setInterval(() => { sync(); refresh({ pins: true, card: true }); }, 60000);
    controls = { el, sync };
    sync();
  }

  function refresh({ pins = false, card = false } = {}) {
    const ms = selectedMs();
    if (pins) markers.forEach((m, id) => { if (profiles.get(id)) applyMarker(id, m, ms); });
    if (card && cardRef && cardRef.el.isConnected && cardRef.el.dataset.venueId === String(cardRef.v.id)) renderCard(cardRef.el, cardRef.v);
  }

  window.SunnySunUI = { onVenuesVisible, decorateMarker, renderCard, _debug: { profiles, stateFor, timelineFor } };
})();
