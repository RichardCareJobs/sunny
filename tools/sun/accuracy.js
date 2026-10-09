#!/usr/bin/env node
/*
  Accuracy report for the sun/shade estimates against observed ground truth.

    node tools/sun/accuracy.js --city dublin --test tools/sun/testsets/dublin_test_set.csv

  Test set CSV (one row per observation; several rows per venue are fine):
    place_id, name, seating_side, observed_seating_lat, observed_seating_lng,
    date (YYYY-MM-DD), time (HH:MM local), observed_state (sun|shade),
    sun_from (HH:MM, optional), sun_until (HH:MM, optional)

  Reads pipeline outputs from tools/sun/data/<city>/out/ (our seating points),
  and, if present, tools/sun/data/<city>/out_observed/ (profiles recomputed at
  the observed seating points: build_profiles.py --overrides <test set> --out out_observed),
  which separates seating-placement error from skyline error.

  Writes tools/sun/reports/<city>_accuracy_<date>.md and .json.
*/
const fs = require("fs");
const path = require("path");
const S = require("../../js/sun-core.js");

const ROOT = __dirname;
const LAUNCH_BAR = 0.8;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const split = (l) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

// Local wall-clock time in a zone -> UTC ms (handles DST).
function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (ms) => { const p = S.zonedParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - ms; };
  let t = wall - offset(wall);
  return wall - offset(t);
}

function loadOut(dir) {
  if (!fs.existsSync(path.join(dir, "profiles.json"))) return null;
  const profiles = JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8"));
  const seating = JSON.parse(fs.readFileSync(path.join(dir, "seating.json"), "utf8"));
  const seat = new Map(seating.map((r) => [r.place_id, r]));
  const out = new Map();
  profiles.forEach((p) => { const s = seat.get(p.place_id); if (s) out.set(p.place_id, { p, s, h: S.decodeHorizon(p.horizon) }); });
  return out;
}

function haversineM(a, b, c, d) {
  const R = 6371008.8, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function band(q) { return q >= 0.66 ? "high (≥0.66)" : q >= 0.33 ? "medium (0.33–0.66)" : "low (<0.33)"; }

function evaluate(model, rows, tz) {
  const obs = [];
  const transitions = [];
  const missing = new Set();
  for (const r of rows) {
    const m = model.get(r.place_id);
    if (!m) { missing.add(r.place_id); continue; }
    const { s, h, p } = m;
    if (r.observed_state === "sun" || r.observed_state === "shade") {
      const t = zonedToUtc(r.date, r.time, tz);
      const st = S.sunState(h, s.seating_lat, s.seating_lng, t).state;
      const pred = st === "sun" ? "sun" : "shade"; // night counts as no direct sun
      obs.push({ place_id: r.place_id, name: r.name, t, observed: r.observed_state, predicted: pred,
        ok: pred === r.observed_state, quality: p.data_quality, band: band(p.data_quality) });
    }
    for (const key of ["sun_from", "sun_until"]) {
      if (!r[key]) continue;
      const t = zonedToUtc(r.date, r[key], tz);
      const tl = S.dayTimeline(h, s.seating_lat, s.seating_lng, t, { timeZone: tz });
      const edges = tl.windows.flatMap(([a, b]) => (key === "sun_from" ? [a] : [b]));
      if (!edges.length) { transitions.push({ place_id: r.place_id, kind: key, errorMin: null }); continue; }
      const best = edges.reduce((x, e) => (Math.abs(e - t) < Math.abs(x - t) ? e : x));
      transitions.push({ place_id: r.place_id, kind: key, errorMin: Math.round((best - t) / 60000) });
    }
  }
  const agree = obs.filter((o) => o.ok).length;
  const byBand = {};
  obs.forEach((o) => { (byBand[o.band] = byBand[o.band] || { n: 0, ok: 0 }).n++; if (o.ok) byBand[o.band].ok++; });
  const errs = transitions.filter((x) => x.errorMin !== null).map((x) => Math.abs(x.errorMin)).sort((a, b) => a - b);
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : null;
  return { n: obs.length, agree, rate: obs.length ? agree / obs.length : null, byBand, obs, transitions,
    transitionMedianAbsMin: median, transitionWithin20: errs.length ? errs.filter((e) => e <= 20).length / errs.length : null,
    missing: Array.from(missing) };
}

function pct(x) { return x === null || x === undefined ? "–" : `${(100 * x).toFixed(0)}%`; }

function main() {
  const city = arg("city", "dublin");
  const testPath = arg("test", path.join(ROOT, "testsets", `${city}_test_set.csv`));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "cities", `${city}.json`), "utf8"));
  const tz = cfg.time_zone;
  const rows = parseCsv(fs.readFileSync(testPath, "utf8"));
  const ours = loadOut(path.join(ROOT, "data", city, "out"));
  if (!ours) throw new Error("no pipeline output; run build_profiles.py first");
  const observedSeat = loadOut(path.join(ROOT, "data", city, "out_observed"));

  const A = evaluate(ours, rows, tz);
  const B = observedSeat ? evaluate(observedSeat, rows, tz) : null;

  // Seating placement vs observation
  const seatErr = [];
  const seen = new Set();
  rows.forEach((r) => {
    if (seen.has(r.place_id)) return; seen.add(r.place_id);
    const m = ours.get(r.place_id);
    if (!m) return;
    const lat = parseFloat(r.observed_seating_lat), lng = parseFloat(r.observed_seating_lng);
    seatErr.push({ place_id: r.place_id, name: r.name, observed_side: r.seating_side || "",
      predicted_type: m.s.seating_type, side_ok: r.seating_side ? r.seating_side === m.s.seating_type : null,
      distance_m: Number.isFinite(lat) && Number.isFinite(lng) ? Math.round(haversineM(lat, lng, m.s.seating_lat, m.s.seating_lng)) : null,
      confidence: m.s.seating_confidence });
  });
  const dists = seatErr.map((e) => e.distance_m).filter((d) => d !== null).sort((a, b) => a - b);
  const sideKnown = seatErr.filter((e) => e.side_ok !== null);

  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Sun/shade accuracy — ${cfg.name} (${date})`, "");
  lines.push(`Algorithm \`${S.ALGORITHM_VERSION}\`. Test set: \`${path.relative(process.cwd(), testPath)}\` — ${new Set(rows.map((r) => r.place_id)).size} venues, ${A.n + A.missing.length} sun/shade observations.`, "");
  lines.push(`**Launch bar:** ≥ ${pct(LAUNCH_BAR)} agreement. **Result:** ${pct(A.rate)} (${A.agree}/${A.n}) — ${A.rate !== null && A.rate >= LAUNCH_BAR ? "meets the bar" : "below the bar"}.`, "");
  lines.push("## Agreement", "", "| Seating point used | Observations | Agree | Rate | Sun-change time, median abs error | Within 20 min |", "|---|---|---|---|---|---|");
  lines.push(`| Ours (pipeline) | ${A.n} | ${A.agree} | ${pct(A.rate)} | ${A.transitionMedianAbsMin ?? "–"} min | ${pct(A.transitionWithin20)} |`);
  if (B) lines.push(`| Observed (your seat) | ${B.n} | ${B.agree} | ${pct(B.rate)} | ${B.transitionMedianAbsMin ?? "–"} min | ${pct(B.transitionWithin20)} |`);
  lines.push("", "## By data quality (our seating point)", "", "| Band | Observations | Agree | Rate |", "|---|---|---|---|");
  Object.entries(A.byBand).sort().forEach(([b, v]) => lines.push(`| ${b} | ${v.n} | ${v.ok} | ${pct(v.ok / v.n)} |`));
  lines.push("", "## Seating placement", "");
  lines.push(`Side matches observation: ${sideKnown.filter((e) => e.side_ok).length}/${sideKnown.length}. ` +
    `Distance to observed seat: median ${dists.length ? dists[Math.floor(dists.length / 2)] : "–"} m, ` +
    `90th percentile ${dists.length ? dists[Math.floor(dists.length * 0.9)] : "–"} m.`, "");
  lines.push("| Venue | Observed side | Our type | Confidence | Distance (m) |", "|---|---|---|---|---|");
  seatErr.forEach((e) => lines.push(`| ${e.name || e.place_id} | ${e.observed_side} | ${e.predicted_type} | ${e.confidence} | ${e.distance_m ?? "–"} |`));
  lines.push("", "## Disagreements", "", "| Venue | Local time | Observed | Predicted | Data quality |", "|---|---|---|---|---|");
  A.obs.filter((o) => !o.ok).forEach((o) => lines.push(`| ${o.name || o.place_id} | ${new Date(o.t).toLocaleString("en-IE", { timeZone: tz })} | ${o.observed} | ${o.predicted} | ${o.quality} |`));
  if (A.missing.length) lines.push("", `Venues in the test set with no profile (not counted): ${A.missing.join(", ")}`);
  lines.push("", "Notes: predictions are clear-sky geometry (weather excluded) so they can be compared with observed direct sun. 'Night' counts as shade.");

  const repDir = path.join(ROOT, "reports");
  fs.mkdirSync(repDir, { recursive: true });
  const base = path.join(repDir, `${city}_accuracy_${date}`);
  fs.writeFileSync(`${base}.md`, lines.join("\n") + "\n");
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ours: A, observedSeat: B, seating: seatErr }, null, 2));
  console.log(lines.slice(0, 12).join("\n"));
  console.log(`\n-> ${base}.md`);
}

main();
