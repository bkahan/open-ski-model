// Builds the static ski dataset the app reads at runtime.
//
// Streams OpenSkiData's daily GeoJSON (runs, lifts, ski areas), keeps the
// handful of fields the model needs, and writes:
//
//   out/cells/<lat>/<lng>.json.gz   runs + lifts touching that 1° cell
//   out/ski-areas.json              search index of operating downhill areas
//   out/metadata.json               source timestamps and counts
//
// A feature that spans cells is written to each of them; readers dedupe
// by id. Coordinates are rounded to 1e-6° (~11 cm). Runs keep only
// downhill use and operating status; lifts keep operating status.
//
// Usage: node scripts/build-ski-data.mjs <outDir>
// Source terms: https://openskidata.org (ODbL, one download per day).

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import chain from "stream-chain";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

const BASE = process.env.OPENSKIDATA_BASE ?? "https://tiles.openskimap.org";
const USER_AGENT = "open-ski-model data build (https://github.com/bkahan/open-ski-model)";
const CELL_DEG = 1;
const PRECISION = 1e6;

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: build-ski-data.mjs <outDir>");
  process.exit(1);
}

/** cellKey -> { runs: [], lifts: [] } */
const cells = new Map();
const skiAreas = [];
const counts = { runs: 0, lifts: 0, skiAreas: 0, runsKept: 0, liftsKept: 0, skiAreasKept: 0 };

function round(v) {
  return Math.round(v * PRECISION) / PRECISION;
}

/** Drop elevation, round, and dedupe consecutive repeats. */
function cleanLine(coords) {
  const out = [];
  for (const c of coords) {
    const p = [round(c[0]), round(c[1])];
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

function linesOf(geometry) {
  switch (geometry.type) {
    case "LineString":
      return { lines: [cleanLine(geometry.coordinates)] };
    case "MultiLineString":
      return { lines: geometry.coordinates.map(cleanLine) };
    case "Polygon":
      return { rings: geometry.coordinates.map(cleanLine) };
    case "MultiPolygon":
      return { rings: geometry.coordinates.flat().map(cleanLine) };
    default:
      return null;
  }
}

function bboxOf(lines) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

function cellsTouching([w, s, e, n]) {
  const keys = [];
  for (let lat = Math.floor(s / CELL_DEG); lat <= Math.floor(n / CELL_DEG); lat++) {
    for (let lng = Math.floor(w / CELL_DEG); lng <= Math.floor(e / CELL_DEG); lng++) {
      keys.push(`${lat}/${lng}`);
    }
  }
  return keys;
}

function cellFor(key) {
  let c = cells.get(key);
  if (!c) {
    c = { runs: [], lifts: [] };
    cells.set(key, c);
  }
  return c;
}

function skiAreaIds(feature) {
  return (feature.properties.skiAreas ?? []).map((a) => a.properties.id);
}

async function streamFeatures(file, onFeature) {
  const url = `${BASE}/geojson/${file}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`);
  let seen = 0;
  const features = chain([
    Readable.fromWeb(res.body),
    parser(),
    pick({ filter: "features" }),
    streamArray(),
  ]);
  for await (const { value } of features) {
    onFeature(value);
    if (++seen % 20000 === 0) console.log(`  ${file}: ${seen}`);
  }
  console.log(`  ${file}: ${seen} features`);
}

function onRun(f) {
  counts.runs++;
  const p = f.properties;
  if (!p.uses?.includes("downhill") || p.status !== "operating") return;
  const geom = linesOf(f.geometry);
  if (!geom) return;
  const shapes = geom.lines ?? geom.rings;
  if (shapes.every((l) => l.length < 2)) return;
  const run = {
    id: p.id,
    n: p.name,
    d: p.difficulty,
    c: p.difficultyConvention,
    a: skiAreaIds(f),
    ...(geom.lines ? { g: geom.lines } : { p: geom.rings }),
  };
  counts.runsKept++;
  for (const key of cellsTouching(bboxOf(shapes))) cellFor(key).runs.push(run);
}

function onLift(f) {
  counts.lifts++;
  const p = f.properties;
  if (p.status !== "operating") return;
  const geom = linesOf(f.geometry);
  if (!geom?.lines) return;
  const lift = { id: p.id, n: p.name, t: p.liftType, a: skiAreaIds(f), g: geom.lines };
  counts.liftsKept++;
  for (const key of cellsTouching(bboxOf(geom.lines))) cellFor(key).lifts.push(lift);
}

function onSkiArea(f) {
  counts.skiAreas++;
  const p = f.properties;
  if (!p.name || p.status !== "operating" || !p.activities?.includes("downhill")) return;
  const vh = p.viewportHint;
  if (!vh?.center) return;
  const place = p.places?.[0];
  const loc = place
    ? [place.localized.en.locality, place.localized.en.region, place.localized.en.country]
        .filter(Boolean)
        .join(", ")
    : null;
  const stats = p.statistics?.runs?.byActivity?.downhill?.byDifficulty ?? {};
  const runCount = Object.values(stats).reduce((sum, s) => sum + (s?.count ?? 0), 0);
  skiAreas.push({
    id: p.id,
    n: p.name,
    loc,
    cc: place?.iso3166_1Alpha2 ?? null,
    conv: p.runConvention,
    vh: [round(vh.center[0]), round(vh.center[1]), vh.bearing ?? 0, Math.round(vh.rotatedWidthMeters), Math.round(vh.rotatedHeightMeters)],
    runs: runCount,
  });
  counts.skiAreasKept++;
}

async function writeGzip(path, data) {
  await pipeline(Readable.from([JSON.stringify(data)]), createGzip({ level: 9 }), createWriteStream(path));
}

const started = new Date().toISOString();
await streamFeatures("ski_areas.geojson", onSkiArea);
await streamFeatures("lifts.geojson", onLift);
await streamFeatures("runs.geojson", onRun);

mkdirSync(join(outDir, "cells"), { recursive: true });
let cellCount = 0;
for (const [key, cell] of cells) {
  const [lat, lng] = key.split("/");
  mkdirSync(join(outDir, "cells", lat), { recursive: true });
  cell.runs.sort((a, b) => (a.id < b.id ? -1 : 1));
  cell.lifts.sort((a, b) => (a.id < b.id ? -1 : 1));
  await writeGzip(join(outDir, "cells", lat, `${lng}.json.gz`), { v: 1, ...cell });
  cellCount++;
}

skiAreas.sort((a, b) => b.runs - a.runs || a.n.localeCompare(b.n));
writeFileSync(join(outDir, "ski-areas.json"), JSON.stringify({ v: 1, areas: skiAreas }));
writeFileSync(
  join(outDir, "metadata.json"),
  JSON.stringify(
    {
      v: 1,
      builtAt: started,
      source: BASE,
      cellDeg: CELL_DEG,
      cells: cellCount,
      ...counts,
      attribution:
        "Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who's On First, © Mapterhorn",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ cells: cellCount, ...counts }));
