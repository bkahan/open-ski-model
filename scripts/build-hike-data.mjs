// Builds the static hiking dataset the app reads at runtime.
//
// Reads the features scripts/extract-hike-features.py pulled out of
// OpenStreetMap extracts (one GeoJSON feature per line) and writes:
//
//   out/cells/<lat>/<lng>.json.gz   trails, peaks, huts, trailheads and
//                                   lakes touching that 1° cell
//   out/hike-places.json            search index: ranges, peaks, trails, huts
//   out/metadata.json               build time and counts
//
// A feature that spans cells is written to each of them; readers dedupe
// by id. State extracts overlap along their borders, so features are
// deduped here too, first region wins.
//
// Usage: node scripts/build-hike-data.mjs <outDir> <features.geojsonseq>...
// Source terms: © OpenStreetMap contributors (ODbL), extracts by Geofabrik.

import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  CELL_DEG,
  bboxOf,
  cellsTouching,
  comparePlaces,
  namedTrails,
  poiFrom,
  poiPlace,
  rangeFrom,
  trailFrom,
  waterFrom,
} from "./hike/features.mjs";

// More cells than this is one of the Great Lakes, and writing it into
// every cell it touches would bloat them all.
const MAX_CELLS_PER_FEATURE = 16;

const [outDir, ...sources] = process.argv.slice(2);
if (!outDir || sources.length === 0) {
  console.error("usage: build-hike-data.mjs <outDir> <features.geojsonseq>...");
  process.exit(1);
}

/** cellKey -> { trails: [], pois: [], water: [] } */
const cells = new Map();
const places = [];
const indexedTrails = [];
const seen = { trails: new Set(), pois: new Set(), water: new Set(), ranges: new Set() };
const counts = { features: 0, trails: 0, peaks: 0, huts: 0, trailheads: 0, water: 0, ranges: 0, skipped: 0 };

function cellFor(key) {
  let cell = cells.get(key);
  if (!cell) {
    cell = { trails: [], pois: [], water: [] };
    cells.set(key, cell);
  }
  return cell;
}

function isNew(kind, id) {
  if (seen[kind].has(id)) return false;
  seen[kind].add(id);
  return true;
}

function addToCells(list, record, bbox) {
  const keys = cellsTouching(bbox);
  if (keys.length > MAX_CELLS_PER_FEATURE) {
    console.warn(`skipping ${record.id}: spans ${keys.length} cells`);
    counts.skipped++;
    return false;
  }
  for (const key of keys) cellFor(key)[list].push(record);
  return true;
}

function onFeature(feature) {
  counts.features++;
  const region = feature.properties.region;

  const trail = trailFrom(feature);
  if (trail) {
    if (isNew("trails", trail.id) && addToCells("trails", trail, bboxOf([trail.g]))) {
      counts.trails++;
      if (trail.n) indexedTrails.push({ ...trail, r: region });
    }
    return;
  }

  const poi = poiFrom(feature);
  if (poi) {
    if (isNew("pois", poi.id) && addToCells("pois", poi, [...poi.c, ...poi.c])) {
      counts[`${poi.k}s`]++;
      const place = poiPlace(poi, region);
      if (place) places.push(place);
    }
    return;
  }

  const water = waterFrom(feature);
  if (water) {
    const outers = water.p.map((polygon) => polygon[0]);
    if (isNew("water", water.id) && addToCells("water", water, bboxOf(outers))) counts.water++;
    return;
  }

  const range = rangeFrom(feature);
  if (range && isNew("ranges", range.id)) {
    places.push(range);
    counts.ranges++;
  }
}

async function readFeatures(path) {
  console.log(`reading ${path}`);
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) onFeature(JSON.parse(line));
  }
}

async function writeGzip(path, data) {
  await pipeline(Readable.from([JSON.stringify(data)]), createGzip({ level: 9 }), createWriteStream(path));
}

const byId = (a, b) => (a.id < b.id ? -1 : 1);

const started = new Date().toISOString();
for (const source of sources) await readFeatures(source);

mkdirSync(join(outDir, "cells"), { recursive: true });
for (const [key, cell] of cells) {
  const [lat, lng] = key.split("/");
  mkdirSync(join(outDir, "cells", lat), { recursive: true });
  cell.trails.sort(byId);
  cell.pois.sort(byId);
  cell.water.sort(byId);
  await writeGzip(join(outDir, "cells", lat, `${lng}.json.gz`), { v: 1, ...cell });
}

places.push(...namedTrails(indexedTrails));
places.sort(comparePlaces);
writeFileSync(join(outDir, "hike-places.json"), JSON.stringify({ v: 1, places }));
writeFileSync(
  join(outDir, "metadata.json"),
  JSON.stringify(
    {
      v: 1,
      builtAt: started,
      cellDeg: CELL_DEG,
      cells: cells.size,
      places: places.length,
      ...counts,
      attribution: "© OpenStreetMap contributors (ODbL). Extracts by Geofabrik.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ cells: cells.size, places: places.length, ...counts }));
