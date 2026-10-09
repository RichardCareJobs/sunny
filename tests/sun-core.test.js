// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/sun-core.js");

const DUBLIN = { lat: 53.3438, lng: -6.2546, tz: "Europe/Dublin" };
const SYDNEY = { lat: -33.8688, lng: 151.2093, tz: "Australia/Sydney" };
const flat = () => new Float32Array(72); // open sky, horizon 0° everywhere
const MIN = 60000;

// Reference values generated independently with the Python `astral` package
// (true geometric altitude, no refraction; azimuth clockwise from north).
const POSITION_REFS = [
  { ...DUBLIN, t: "2026-06-21T15:00:00Z", alt: 48.509, az: 239.092 },
  { ...DUBLIN, t: "2026-03-20T09:00:00Z", alt: 20.915, az: 121.092 },
  { ...SYDNEY, t: "2026-06-21T02:00:00Z", alt: 32.689, az: 359.154 },
  { ...SYDNEY, t: "2026-12-21T22:00:00Z", alt: 38.409, az: 94.542 },
];

test("sun position matches an independent reference (both hemispheres)", () => {
  for (const r of POSITION_REFS) {
    const p = S.sunPosition(new Date(r.t), r.lat, r.lng);
    assert.ok(Math.abs(p.trueAltitudeDeg - r.alt) < 0.05, `${r.t} alt ${p.trueAltitudeDeg} vs ${r.alt}`);
    const dAz = Math.abs(((p.azimuthDeg - r.az + 540) % 360) - 180);
    assert.ok(dAz < 0.1, `${r.t} az ${p.azimuthDeg} vs ${r.az}`);
    assert.ok(p.altitudeDeg >= p.trueAltitudeDeg, "refraction lifts the apparent sun");
  }
});

// Official sunrise/sunset = upper limb on the horizon = true centre altitude −0.833°.
function crossing(lat, lng, a, b, rising) {
  const f = (t) => S.sunPosition(t, lat, lng).trueAltitudeDeg + 0.833;
  while (b - a > 1000) { const m = (a + b) / 2; if ((f(m) > 0) === rising) b = m; else a = m; }
  return b;
}
const SUNRISE_REFS = [
  { ...DUBLIN, day: "2026-06-21", rise: "03:57:04", set: "20:56:36" },  // UTC (IST = UTC+1)
  { ...DUBLIN, day: "2026-12-21", rise: "08:38:31", set: "16:07:40" },
  { ...SYDNEY, day: "2026-06-20", rise: "21:00:11", set: "06:53:35", setNextDay: true }, // UTC (AEST = UTC+10)
];

test("sunrise and sunset times match the reference within a minute", () => {
  for (const r of SUNRISE_REFS) {
    const d0 = Date.parse(`${r.day}T00:00:00Z`);
    const rise = Date.parse(`${r.day}T${r.rise}Z`);
    const set = Date.parse(`${r.day}T${r.set}Z`) + (r.setNextDay ? 86400000 : 0);
    const gotRise = crossing(r.lat, r.lng, rise - 3600000, rise + 3600000, true);
    const gotSet = crossing(r.lat, r.lng, set - 3600000, set + 3600000, false);
    assert.ok(Math.abs(gotRise - rise) < MIN, `${r.day} rise off by ${(gotRise - rise) / 1000}s`);
    assert.ok(Math.abs(gotSet - set) < MIN, `${r.day} set off by ${(gotSet - set) / 1000}s`);
    assert.ok(d0 > 0);
  }
});

test("open-sky timeline runs from just after sunrise to just before sunset", () => {
  // Brief's rule: sun centre above 0° (apparent). That's a few minutes inside official rise/set.
  const tl = S.dayTimeline(flat(), DUBLIN.lat, DUBLIN.lng, new Date("2026-06-21T12:00:00Z"), { timeZone: DUBLIN.tz });
  assert.equal(tl.windows.length, 1);
  const [a, b] = tl.windows[0];
  const rise = Date.parse("2026-06-21T03:57:04Z"), set = Date.parse("2026-06-21T20:56:36Z");
  assert.ok(a - rise >= 0 && a - rise < 8 * MIN, `start ${(a - rise) / MIN} min after sunrise`);
  assert.ok(set - b >= 0 && set - b < 8 * MIN, `end ${(set - b) / MIN} min before sunset`);
});

test("sunrise edge: sun just above 0° but below the skyline is shade; just above is sun", () => {
  const t = new Date("2026-06-21T05:00:00Z"); // early morning Dublin, low sun in the north-east
  const sun = S.sunPosition(t, DUBLIN.lat, DUBLIN.lng);
  assert.ok(sun.altitudeDeg > 0 && sun.altitudeDeg < 15);
  const h = new Float32Array(72).fill(sun.altitudeDeg + 0.5);
  assert.equal(S.isInSun(h, sun), false);
  h.fill(sun.altitudeDeg - 0.5);
  assert.equal(S.isInSun(h, sun), true);
});

test("below the horizon is night even with a negative (rooftop) skyline", () => {
  const h = new Float32Array(72).fill(-3);
  const sun = { altitudeDeg: -0.5, azimuthDeg: 300 };
  assert.equal(S.isInSun(h, sun), false);
  assert.equal(S.isInSun(h, { altitudeDeg: 0.4, azimuthDeg: 300 }), true);
});

test("horizon interpolates between 5° steps and wraps 355° → 0°", () => {
  const h = new Float32Array(72);
  h[71] = 10; h[0] = 20; h[1] = 30;
  assert.equal(S.horizonAt(h, 357.5), 15);
  assert.equal(S.horizonAt(h, 2.5), 25);
  assert.equal(S.horizonAt(h, 360), 20);
  assert.equal(S.horizonAt(h, -2.5), 15);
});

// A tall wall occupying azimuths [from,to] at `deg` elevation.
function wall(from, to, deg) {
  const h = new Float32Array(72);
  for (let i = 0; i < 72; i++) { const az = i * 5; if (az >= from && az <= to) h[i] = deg; }
  return h;
}

test("southern hemisphere: midday sun is to the north, so a northern wall shades in Sydney", () => {
  const noon = new Date("2026-06-21T02:00:00Z"); // ~noon AEST
  const north = wall(0, 30, 60); north.set(wall(330, 355, 60).subarray(66), 66);
  const south = wall(150, 210, 75);
  assert.equal(S.sunState(north, SYDNEY.lat, SYDNEY.lng, noon).state, "shade");
  assert.equal(S.sunState(south, SYDNEY.lat, SYDNEY.lng, noon).state, "sun");
  // …and the mirror image in Dublin.
  const dNoon = new Date("2026-06-21T12:26:00Z");
  assert.equal(S.sunState(south, DUBLIN.lat, DUBLIN.lng, dNoon).state, "shade");
  assert.equal(S.sunState(north, DUBLIN.lat, DUBLIN.lng, dNoon).state, "sun");
});

test("cloud only downgrades sun; shade stays shade", () => {
  const t = new Date("2026-06-21T12:26:00Z");
  assert.equal(S.sunState(flat(), DUBLIN.lat, DUBLIN.lng, t, { cloudCover: 90 }).state, "cloud");
  assert.equal(S.sunState(flat(), DUBLIN.lat, DUBLIN.lng, t, { cloudCover: 20 }).state, "sun");
  assert.equal(S.sunState(wall(150, 210, 80), DUBLIN.lat, DUBLIN.lng, t, { cloudCover: 90 }).state, "shade");
  assert.equal(S.sunState(flat(), DUBLIN.lat, DUBLIN.lng, new Date("2026-06-21T23:30:00Z")).state, "night");
});

test("western wall cuts the evening short; sun line reads 'Sun until …'", () => {
  const h = wall(240, 320, 25);
  const day = new Date("2026-06-21T12:00:00Z");
  const tl = S.dayTimeline(h, DUBLIN.lat, DUBLIN.lng, day, { timeZone: DUBLIN.tz });
  assert.equal(tl.windows.length, 1);
  const end = tl.windows[0][1];
  const sunAtEnd = S.sunPosition(end, DUBLIN.lat, DUBLIN.lng);
  assert.ok(Math.abs(sunAtEnd.altitudeDeg - 25) < 0.5, `ends when sun drops to the wall (${sunAtEnd.altitudeDeg})`);
  const line = S.sunLine(tl, Date.parse("2026-06-21T13:00:00Z"), DUBLIN.tz, "sun");
  assert.match(line, /^Sun until \d{1,2}:\d0pm$/);
  const before = S.sunLine(tl, Date.parse("2026-06-21T02:00:00Z"), DUBLIN.tz, "night");
  assert.match(before, /^Sun from \d{1,2}:\d0am$/);
  assert.equal(S.sunLine(tl, Date.parse("2026-06-21T22:30:00Z"), DUBLIN.tz, "night"), "No more direct sun today");
});

test("a gap between buildings gives two sun windows", () => {
  const h = new Float32Array(72).fill(70);
  for (let az = 130; az <= 150; az += 5) h[az / 5] = 0; // south-east gap only
  for (let az = 220; az <= 330; az += 5) h[az / 5] = 0; // open west
  const tl = S.dayTimeline(h, DUBLIN.lat, DUBLIN.lng, new Date("2026-06-21T12:00:00Z"), { timeZone: DUBLIN.tz });
  assert.equal(tl.windows.length, 2);
});

test("local day handles DST changes (23 h and 25 h days)", () => {
  const spring = S.dayTimeline(flat(), DUBLIN.lat, DUBLIN.lng, new Date("2026-03-29T12:00:00Z"), { timeZone: DUBLIN.tz });
  assert.equal((spring.dayEnd - spring.dayStart) / 3600000, 23);
  const autumn = S.dayTimeline(flat(), DUBLIN.lat, DUBLIN.lng, new Date("2026-10-25T12:00:00Z"), { timeZone: DUBLIN.tz });
  assert.equal((autumn.dayEnd - autumn.dayStart) / 3600000, 25);
  assert.equal(new Date(S.startOfLocalDay(new Date("2026-06-21T12:00:00Z"), SYDNEY.tz)).toISOString(), "2026-06-20T14:00:00.000Z");
});

test("formatClock rounds to 10 minutes in the venue's time zone", () => {
  assert.equal(S.formatClock(Date.parse("2026-06-21T17:38:00Z"), DUBLIN.tz), "6:40pm");
  assert.equal(S.formatClock(Date.parse("2026-06-21T11:04:00Z"), DUBLIN.tz), "12:00pm");
  assert.equal(S.formatClock(Date.parse("2026-06-20T23:01:00Z"), DUBLIN.tz), "12:00am");
});

test("decode/encode round-trip and validation", () => {
  const deg = Array.from({ length: 72 }, (_, i) => (i - 20) * 1.23);
  const back = S.decodeHorizon(S.encodeHorizon(deg));
  deg.forEach((d, i) => assert.ok(Math.abs(back[i] - d) <= 0.0501));
  assert.equal(S.decodeHorizon([1, 2, 3]), null);
  assert.equal(S.decodeHorizon(null), null);
});

test("performance: live check + 24 h timeline well under 50 ms per venue", () => {
  const h = wall(200, 300, 20);
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) {
    const now = new Date(Date.parse("2026-06-21T12:00:00Z") + i * 60000);
    S.sunState(h, DUBLIN.lat, DUBLIN.lng, now);
    S.dayTimeline(h, DUBLIN.lat, DUBLIN.lng, now, { timeZone: DUBLIN.tz });
  }
  const perVenueMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  // Mid-range phones are roughly 4–6× slower than CI hardware; keep a big margin.
  assert.ok(perVenueMs < 5, `per venue ${perVenueMs.toFixed(3)} ms`);
});
