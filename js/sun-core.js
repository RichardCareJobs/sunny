/*
  Sunny — sun-core.js
  Pure, dependency-free sun/shade maths shared by the browser, the batch
  pipeline (tools/sun) and the tests. Loads as a classic <script> (exposes
  window.SunnySun) and via require() in Node.

  Conventions
  - Azimuth: degrees clockwise from true north, 0–360. Works in both
    hemispheres; nothing assumes the sun is to the south.
  - Horizon profile: 72 values, one per 5° of azimuth starting at 0° (north).
    Stored in the database as smallint tenths of a degree.
  - Sun position: NOAA solar-position algorithm (accurate to ~0.01° for
    1900–2100) with the NOAA atmospheric refraction correction, so the
    altitude returned is the apparent altitude an observer would see.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnySun = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ALGORITHM_VERSION = "horizon-v1";
  const HORIZON_STEPS = 72;
  const HORIZON_STEP_DEG = 360 / HORIZON_STEPS;
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;

  // ── Sun position (NOAA) ────────────────────────────────────────────────────
  function refractionDeg(elevDeg) {
    if (elevDeg > 85) return 0;
    const te = Math.tan(elevDeg * RAD);
    let arcsec;
    if (elevDeg > 5) arcsec = 58.1 / te - 0.07 / (te * te * te) + 0.000086 / Math.pow(te, 5);
    else if (elevDeg > -0.575) arcsec = 1735 + elevDeg * (-518.2 + elevDeg * (103.4 + elevDeg * (-12.79 + elevDeg * 0.711)));
    else arcsec = -20.774 / te;
    return arcsec / 3600;
  }

  function sunPosition(date, lat, lng) {
    const ms = date instanceof Date ? date.getTime() : Number(date);
    const jd = ms / 86400000 + 2440587.5;
    const T = (jd - 2451545) / 36525;
    const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = M * RAD;
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
      + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
      + Math.sin(3 * Mr) * 0.000289;
    const omega = (125.04 - 1934.136 * T) * RAD;
    const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const y = Math.pow(Math.tan(eps / 2), 2);
    const L0r = L0 * RAD;
    const eqTimeMin = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr)
      + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
      - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
    const utcMin = ((ms % 86400000) + 86400000) % 86400000 / 60000;
    const tst = ((utcMin + eqTimeMin + 4 * lng) % 1440 + 1440) % 1440;
    const ha = (tst / 4 - 180) * RAD;
    const phi = lat * RAD;
    const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
    const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen)));
    const trueElev = 90 - zenith * DEG;
    const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) * DEG + 180;
    return {
      azimuthDeg: ((az % 360) + 360) % 360,
      altitudeDeg: trueElev + refractionDeg(trueElev),
      trueAltitudeDeg: trueElev,
    };
  }

  // ── Horizon profile ────────────────────────────────────────────────────────
  // Accepts tenths-of-a-degree integers (as stored) and returns degrees.
  function decodeHorizon(tenths) {
    if (!tenths || tenths.length !== HORIZON_STEPS) return null;
    const out = new Float32Array(HORIZON_STEPS);
    for (let i = 0; i < HORIZON_STEPS; i++) {
      const v = Number(tenths[i]);
      if (!Number.isFinite(v)) return null;
      out[i] = v / 10;
    }
    return out;
  }

  function encodeHorizon(degrees) {
    return Array.from(degrees, (d) => Math.max(-900, Math.min(900, Math.round(d * 10))));
  }

  // Linear interpolation between 5° steps, wrapping 355° → 0°.
  function horizonAt(horizonDeg, azimuthDeg) {
    const a = ((azimuthDeg % 360) + 360) % 360;
    const pos = a / HORIZON_STEP_DEG;
    const i0 = Math.floor(pos) % HORIZON_STEPS;
    const i1 = (i0 + 1) % HORIZON_STEPS;
    const f = pos - Math.floor(pos);
    return horizonDeg[i0] * (1 - f) + horizonDeg[i1] * f;
  }

  // ── Sun vs horizon ────────────────────────────────────────────────────────
  // Direct sun when the sun is above 0° and above the skyline in its direction.
  function isInSun(horizonDeg, sun) {
    if (!(sun.altitudeDeg > 0)) return false;
    return sun.altitudeDeg > horizonAt(horizonDeg, sun.azimuthDeg);
  }

  // state: 'sun' | 'shade' | 'night' | 'cloud'
  // cloudCover: 0–100 (%), optional. 'cloud' only replaces 'sun' — shade stays shade.
  function sunState(horizonDeg, lat, lng, date, { cloudCover = null, cloudThreshold = 75 } = {}) {
    const sun = sunPosition(date, lat, lng);
    if (!(sun.altitudeDeg > 0)) return { state: "night", sun };
    const geometricSun = sun.altitudeDeg > horizonAt(horizonDeg, sun.azimuthDeg);
    if (!geometricSun) return { state: "shade", sun };
    if (typeof cloudCover === "number" && cloudCover >= cloudThreshold) return { state: "cloud", sun };
    return { state: "sun", sun };
  }

  // ── Time zones ────────────────────────────────────────────────────────────
  const _dtfCache = new Map();
  function _dtf(timeZone) {
    let f = _dtfCache.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      _dtfCache.set(timeZone, f);
    }
    return f;
  }
  function zonedParts(ms, timeZone) {
    const p = {};
    for (const part of _dtf(timeZone).formatToParts(new Date(ms))) p[part.type] = part.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
  }
  function tzOffsetMs(ms, timeZone) {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - (ms - (ms % 1000));
  }
  // UTC ms of local midnight (start of the local day containing `date`).
  function startOfLocalDay(date, timeZone) {
    const ms = date instanceof Date ? date.getTime() : Number(date);
    const p = zonedParts(ms, timeZone);
    const wall = Date.UTC(p.y, p.m - 1, p.d);
    let guess = wall - tzOffsetMs(wall, timeZone);
    guess = wall - tzOffsetMs(guess, timeZone);
    return guess;
  }

  // ── Day timeline ──────────────────────────────────────────────────────────
  // Samples the local day at stepMin steps, refines each sun/shade transition
  // to ~1 minute by bisection, and returns sun windows as [startMs, endMs).
  function dayTimeline(horizonDeg, lat, lng, date, { timeZone = "UTC", stepMin = 10 } = {}) {
    const start = startOfLocalDay(date, timeZone);
    const end = startOfLocalDay(start + 36 * 3600000, timeZone); // next local midnight (handles DST)
    const stepMs = stepMin * 60000;
    const lit = (t) => isInSun(horizonDeg, sunPosition(t, lat, lng));
    const refine = (a, b, litAtA) => {
      while (b - a > 60000) {
        const mid = (a + b) / 2;
        if (lit(mid) === litAtA) a = mid; else b = mid;
      }
      return Math.round(b);
    };
    const windows = [];
    let prevT = start;
    let prev = lit(start);
    let openAt = prev ? start : null;
    for (let t = start + stepMs; t <= end; t += stepMs) {
      const tt = Math.min(t, end);
      const cur = lit(tt);
      if (cur !== prev) {
        const edge = refine(prevT, tt, prev);
        if (cur) openAt = edge;
        else { windows.push([openAt, edge]); openAt = null; }
      }
      prev = cur; prevT = tt;
    }
    if (openAt !== null) windows.push([openAt, end]);
    return { dayStart: start, dayEnd: end, windows };
  }

  // Summarise "now" against the timeline: what's the next change today?
  // Returns { inSun, until } when in a window, { inSun:false, from } when a
  // later window exists, or { inSun:false, none:true } when no more sun today.
  function nextChange(timeline, nowMs) {
    for (const [a, b] of timeline.windows) {
      if (nowMs >= a && nowMs < b) return { inSun: true, until: b, untilEndOfDay: b >= timeline.dayEnd };
      if (a > nowMs) return { inSun: false, from: a };
    }
    return { inSun: false, none: true };
  }

  function roundToMinutes(ms, minutes = 10) {
    const step = minutes * 60000;
    return Math.round(ms / step) * step;
  }

  // "6:40pm" in the venue's time zone, rounded to 10 minutes.
  function formatClock(ms, timeZone, { roundMin = 10 } = {}) {
    const p = zonedParts(roundToMinutes(ms, roundMin), timeZone);
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    return `${h12}:${String(p.min).padStart(2, "0")}${p.h < 12 ? "am" : "pm"}`;
  }

  // Human sun line for the venue card.
  function sunLine(timeline, nowMs, timeZone, state) {
    const nc = nextChange(timeline, nowMs);
    if (state === "cloud") {
      return nc.inSun ? `Sun hidden by cloud · clear-sky sun until ${formatClock(nc.until, timeZone)}` : "Sun hidden by cloud";
    }
    if (nc.inSun) return nc.untilEndOfDay ? "In sun" : `Sun until ${formatClock(nc.until, timeZone)}`;
    if (nc.from) return `Sun from ${formatClock(nc.from, timeZone)}`;
    return "No more direct sun today";
  }

  return {
    ALGORITHM_VERSION, HORIZON_STEPS, HORIZON_STEP_DEG,
    sunPosition, refractionDeg,
    decodeHorizon, encodeHorizon, horizonAt,
    isInSun, sunState,
    startOfLocalDay, zonedParts,
    dayTimeline, nextChange, formatClock, sunLine,
  };
});
