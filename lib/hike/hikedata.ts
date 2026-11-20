// Reads the static hiking dataset built by scripts/build-hike-data.mjs
// and published on the repo's `hike-data` branch. Server-side only.
//
// Same shape as the ski dataset (lib/resort/skidata.ts): 1° cells plus a
// search index, fetched through jsDelivr's CDN.

import {
  cellsTouching,
  extentOf,
  fetchGzipJson,
  fetchJson,
  foldName,
  intersects,
  lineBbox,
  nameMatchScore,
} from "@/lib/data/static-data";
import type { Bbox, LngLat } from "@/lib/types";

import type {
  HikeData,
  HikePlaceHit,
  HikePlaceKind,
  HikePoi,
  HikePoiKind,
  HikeTrail,
  HikeWater,
} from "./types";

const DEFAULT_BASE = "https://cdn.jsdelivr.net/gh/bkahan/open-ski-model@hike-data";

// Wire format written by the build script.
interface CellTrail {
  id: string;
  n: string | null;
  i?: 1;
  g: LngLat[];
}
interface CellPoi {
  id: string;
  k: HikePoiKind;
  n: string | null;
  e?: number;
  c: LngLat;
}
interface CellWater {
  id: string;
  n: string | null;
  /** Polygons, each [outer, ...holes]. */
  p: LngLat[][][];
}
interface Cell {
  v: number;
  trails: CellTrail[];
  pois: CellPoi[];
  water: CellWater[];
}
interface IndexPlace {
  id: string;
  n: string;
  k: HikePlaceKind;
  r?: string;
  c: LngLat;
  b?: Bbox;
  e?: number;
  km?: number;
}
interface Index {
  v: number;
  places: IndexPlace[];
}

export function hikeDataBaseUrl(): string {
  return (process.env.HIKE_DATA_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
}

const EMPTY_CELL: Cell = { v: 1, trails: [], pois: [], water: [] };

async function fetchCell(lat: number, lng: number): Promise<Cell> {
  return (await fetchGzipJson<Cell>(`${hikeDataBaseUrl()}/cells/${lat}/${lng}.json.gz`)) ?? EMPTY_CELL;
}

async function fetchIndex(): Promise<Index> {
  const index = await fetchJson<Index>(`${hikeDataBaseUrl()}/hike-places.json`);
  if (!index) throw new Error("hike-places.json missing from hike-data branch");
  return index;
}

function contains([w, s, e, n]: Bbox, [lng, lat]: LngLat): boolean {
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

/** Merge cells into HikeData, keeping only features that touch `bbox`. */
export function assembleHike(cells: Cell[], bbox: Bbox): HikeData {
  const trails = new Map<string, HikeTrail>();
  const pois = new Map<string, HikePoi>();
  const water = new Map<string, HikeWater>();

  for (const cell of cells) {
    for (const t of cell.trails) {
      if (trails.has(t.id) || t.g.length < 2 || !intersects(lineBbox(t.g), bbox)) continue;
      trails.set(t.id, { id: t.id, name: t.n ?? undefined, informal: t.i === 1, coords: t.g });
    }
    for (const p of cell.pois) {
      if (pois.has(p.id) || !contains(bbox, p.c)) continue;
      pois.set(p.id, { id: p.id, kind: p.k, name: p.n ?? undefined, elevationMeters: p.e, at: p.c });
    }
    for (const w of cell.water) {
      w.p.forEach(([outer, ...holes], i) => {
        const id = w.p.length > 1 ? `${w.id}:${i}` : w.id;
        if (water.has(id) || !outer || !intersects(lineBbox(outer), bbox)) return;
        water.set(id, { id, name: w.n ?? undefined, outer, holes });
      });
    }
  }

  const trailList = [...trails.values()];
  return {
    trails: trailList,
    pois: [...pois.values()],
    water: [...water.values()],
    bbox,
    extent: extentOf(trailList.map((trail) => trail.coords)),
  };
}

export async function loadHikeData(bbox: Bbox): Promise<HikeData> {
  const cells = await Promise.all(cellsTouching(bbox).map(([lat, lng]) => fetchCell(lat, lng)));
  return assembleHike(cells, bbox);
}

/** Rank places by name match: exact, prefix, word prefix, substring. */
export function searchPlaces(index: Index, query: string, limit = 8): HikePlaceHit[] {
  const q = foldName(query);
  if (!q) return [];
  const scored: Array<{ score: number; place: IndexPlace }> = [];
  for (const place of index.places) {
    const score = nameMatchScore(place.n, q);
    if (score > 0) scored.push({ score, place });
  }
  // The index is already ordered ranges, peaks by height, trails by
  // length, huts; a stable sort by score keeps that order within a tier.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ place }) => ({
    id: place.id,
    name: place.n,
    kind: place.k,
    region: place.r ?? null,
    center: place.c,
    bbox: place.b ?? null,
    elevationMeters: place.e,
    lengthKm: place.km,
  }));
}

export async function searchHikePlaces(query: string, limit?: number): Promise<HikePlaceHit[]> {
  return searchPlaces(await fetchIndex(), query, limit);
}
