// Server-side elevation pipeline using AWS Open Data "terrain tiles."
//
// Mental model:
//   - The Earth is mapped onto a giant pixel canvas at each Web Mercator
//     zoom level. At zoom z the canvas is 2^z tiles wide, each 256x256 px.
//   - Each pixel encodes elevation via the "terrarium" RGB scheme:
//         elevation_m = (R * 256 + G + B / 256) - 32768
//   - To build a height grid for a bbox: pick the right zoom (one source
//     pixel ≈ one output cell), figure out which tiles cover the bbox,
//     fetch + decode them, and bilinearly sample.
//
// The tiles live in a public AWS S3 bucket — no auth, no key, plain HTTPS:
//   https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
// Coverage is global, blended from SRTM/NED/ETOPO/GMTED.

import { PNG } from "pngjs";

import type { Bbox } from "@/lib/types";
import type { ElevationResponse } from "./types";

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_SIZE = 256;
const MIN_ZOOM = 0;
const MAX_ZOOM = 15; // terrarium goes 0..15
const TILE_URL = (z: number, x: number, y: number) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

// --- Web Mercator helpers ---

/** Pixels-per-degree-longitude at a given zoom, ignoring latitude. */
function worldPixelsX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z) * TILE_SIZE;
}

/** Pixel-y at given lat / zoom. Web Mercator. */
function worldPixelsY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180;
  const merc = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad));
  return ((1 - merc / Math.PI) / 2) * Math.pow(2, z) * TILE_SIZE;
}

/** Meters per source pixel at a given latitude + zoom. */
function metersPerPixel(lat: number, z: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) /
    (Math.pow(2, z) * TILE_SIZE);
}

/**
 * Pick the lowest zoom such that one source pixel is at least as fine as
 * one output cell. Going one zoom higher than necessary wastes bandwidth
 * and makes the model noisier without adding real detail.
 */
export function pickZoom(bbox: Bbox, gridSize: number): number {
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const bboxWidthMeters =
    ((bbox[2] - bbox[0]) * (EARTH_CIRCUMFERENCE_M / 360)) *
    Math.cos((centerLat * Math.PI) / 180);
  const targetMpp = bboxWidthMeters / gridSize;

  // Solve: metersPerPixel(centerLat, z) <= targetMpp
  // => z >= log2(EARTH_CIRC * cos(lat) / (targetMpp * TILE_SIZE))
  const z = Math.ceil(
    Math.log2(
      (EARTH_CIRCUMFERENCE_M * Math.cos((centerLat * Math.PI) / 180)) /
        (targetMpp * TILE_SIZE),
    ),
  );
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// --- Tile fetching + decoding ---

interface DecodedTile {
  /** Tile origin pixel in the global pixel canvas. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Raw RGBA buffer, length = width * height * 4. */
  rgba: Buffer;
}

const TILE_CACHE_MAX = 256;
const tileCache = new Map<string, Promise<DecodedTile>>();

async function fetchTile(z: number, x: number, y: number): Promise<DecodedTile> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const url = TILE_URL(z, x, y);
      const res = await fetch(url, {
        // Vercel's fetch supports HTTP caching. Tiles are immutable, so cache
        // aggressively at the edge.
        cache: "force-cache",
        next: { revalidate: 60 * 60 * 24 * 30 }, // 30 days
      });
      if (!res.ok) {
        throw new Error(`terrarium ${key}: ${res.status} ${res.statusText}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const png = PNG.sync.read(buf);
      return {
        x0: x * TILE_SIZE,
        y0: y * TILE_SIZE,
        width: png.width,
        height: png.height,
        rgba: png.data,
      };
    } catch (err) {
      // Don't cache the failure — otherwise every future request for this tile
      // returns the cached rejection for the lifetime of the function instance.
      tileCache.delete(key);
      throw err;
    }
  })();
  // Trim before insert so the map stays at or below the cap.
  while (tileCache.size >= TILE_CACHE_MAX) {
    const firstKey = tileCache.keys().next().value;
    if (!firstKey) break;
    tileCache.delete(firstKey);
  }
  tileCache.set(key, promise);
  return promise;
}

/**
 * Pre-fetch every tile we need for this bbox at once, in parallel.
 * Returns a sparse 2D array keyed by (tileX, tileY) for quick lookup.
 */
async function loadTilesForBbox(bbox: Bbox, z: number): Promise<Map<string, DecodedTile>> {
  const [w, s, e, n] = bbox;
  // Clamp to valid Mercator range. Tiles at extreme latitudes don't exist.
  const minLat = Math.max(-85.05, s);
  const maxLat = Math.min(85.05, n);

  const xMin = Math.floor(worldPixelsX(w, z) / TILE_SIZE);
  const xMax = Math.floor(worldPixelsX(e, z) / TILE_SIZE);
  // y axis is inverted in Mercator (north is small y).
  const yMin = Math.floor(worldPixelsY(maxLat, z) / TILE_SIZE);
  const yMax = Math.floor(worldPixelsY(minLat, z) / TILE_SIZE);

  const jobs: Promise<[string, DecodedTile]>[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      jobs.push(
        fetchTile(z, x, y).then((t) => [`${x}/${y}`, t] as [string, DecodedTile]),
      );
    }
  }
  const results = await Promise.all(jobs);
  return new Map(results);
}

/** Decode an RGBA pixel at (px, py) within a tile into meters. */
function pixelToMeters(tile: DecodedTile, px: number, py: number): number {
  const idx = (py * tile.width + px) * 4;
  const r = tile.rgba[idx];
  const g = tile.rgba[idx + 1];
  const b = tile.rgba[idx + 2];
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Bilinear sample of elevation at fractional global pixel (gx, gy).
 * If the surrounding tiles are missing, returns NaN.
 */
function sampleBilinear(
  tiles: Map<string, DecodedTile>,
  gx: number,
  gy: number,
): number {
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = gx - x0;
  const fy = gy - y0;

  const sample = (px: number, py: number): number => {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    return pixelToMeters(tile, px - tile.x0, py - tile.y0);
  };

  const v00 = sample(x0, y0);
  const v10 = sample(x1, y0);
  const v01 = sample(x0, y1);
  const v11 = sample(x1, y1);
  // If any neighbor is NaN, fall back to nearest-neighbor — better than NaN
  // streaks ruining min/max.
  if ([v00, v10, v01, v11].some((v) => Number.isNaN(v))) {
    const fallback = [v00, v10, v01, v11].find((v) => !Number.isNaN(v));
    return fallback ?? NaN;
  }
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}

// --- Public API ---

export async function buildHeightGrid(
  bbox: Bbox,
  gridSize: number,
): Promise<ElevationResponse> {
  if (gridSize < 16 || gridSize > 512) {
    throw new Error(`gridSize must be 16..512, got ${gridSize}`);
  }
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n)) throw new Error("invalid bbox");

  const z = pickZoom(bbox, gridSize);
  const tiles = await loadTilesForBbox(bbox, z);

  const heights = new Array<number>(gridSize * gridSize);
  let min = Infinity;
  let max = -Infinity;

  // Map output cell (i, j) -> world pixel (gx, gy). Output row 0 is north
  // (large lat → small pixel y).
  for (let j = 0; j < gridSize; j++) {
    const t = j / (gridSize - 1);
    const lat = n - t * (n - s);
    const gy = worldPixelsY(lat, z);
    for (let i = 0; i < gridSize; i++) {
      const u = i / (gridSize - 1);
      const lng = w + u * (e - w);
      const gx = worldPixelsX(lng, z);
      const h = sampleBilinear(tiles, gx, gy);
      heights[j * gridSize + i] = h;
      if (!Number.isNaN(h)) {
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("no valid elevation data in bbox");
  }

  return {
    heights,
    width: gridSize,
    height: gridSize,
    min,
    max,
    source: "terrarium",
    zoom: z,
  };
}
