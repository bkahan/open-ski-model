// Reads the static ski dataset built by scripts/build-ski-data.mjs and
// published on the repo's `data` branch. Server-side only.
//
// The data is 1° cells of runs and lifts plus a ski-area index, fetched
// through jsDelivr's CDN. No query server is involved, which is the
// point: the public Overpass instances were rejecting even trivial
// queries under load.

import { gunzipSync } from "node:zlib";

import type { Bbox, LngLat } from "@/lib/types";

import type {
  LiftType,
  ResortData,
  RunConvention,
  RunDifficulty,
  SkiAreaHit,
  SkiLift,
  SkiRun,
} from "./types";

const DEFAULT_BASE = "https://cdn.jsdelivr.net/gh/bkahan/open-ski-model@data";
const CELL_DEG = 1;
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

// Wire format written by the build script.
interface CellRun {
  id: string;
  n: string | null;
  d: RunDifficulty | null;
  c: RunConvention;
  a: string[];
  g?: LngLat[][];
  p?: LngLat[][];
}
interface CellLift {
  id: string;
  n: string | null;
  t: string;
  a: string[];
  g: LngLat[][];
}
interface Cell {
  v: number;
  runs: CellRun[];
  lifts: CellLift[];
}
interface IndexArea {
  id: string;
  n: string;
  loc: string | null;
  cc: string | null;
  conv: RunConvention;
  vh: [number, number, number, number, number];
  runs: number;
}
interface Index {
  v: number;
  areas: IndexArea[];
}

const DIFFICULTIES: ReadonlySet<string> = new Set([
  "novice",
  "easy",
  "intermediate",
  "advanced",
  "expert",
  "freeride",
  "extreme",
]);
const LIFT_TYPES: ReadonlySet<string> = new Set([
  "chair_lift",
  "gondola",
  "cable_car",
  "mixed_lift",
  "drag_lift",
  "t-bar",
  "j-bar",
  "platter",
  "rope_tow",
  "magic_carpet",
  "funicular",
  "railway",
]);

export function dataBaseUrl(): string {
  return (process.env.SKI_DATA_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
}

const CACHE_MAX_ENTRIES = 256;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Fetch + parse once per URL per TTL; concurrent callers share the promise. */
function cached<T>(url: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;

  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  const entry = { at: now, value: undefined as unknown as Promise<unknown> };
  entry.value = load().catch((err: unknown) => {
    if (cache.get(url) === entry) cache.delete(url);
    throw err;
  });
  cache.set(url, entry);
  return entry.value as Promise<T>;
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

const EMPTY_CELL: Cell = { v: 1, runs: [], lifts: [] };

export function fetchCell(lat: number, lng: number): Promise<Cell> {
  const url = `${dataBaseUrl()}/cells/${lat}/${lng}.json.gz`;
  return cached(url, async () => {
    const bytes = await fetchBytes(url);
    if (!bytes) return EMPTY_CELL;
    return JSON.parse(gunzipSync(Buffer.from(bytes)).toString("utf8")) as Cell;
  });
}

export function fetchIndex(): Promise<Index> {
  const url = `${dataBaseUrl()}/ski-areas.json`;
  return cached(url, async () => {
    const bytes = await fetchBytes(url);
    if (!bytes) throw new Error("ski-areas.json missing from data branch");
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as Index;
  });
}

export function cellsTouching([w, s, e, n]: Bbox): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let lat = Math.floor(s / CELL_DEG); lat <= Math.floor(n / CELL_DEG); lat++) {
    for (let lng = Math.floor(w / CELL_DEG); lng <= Math.floor(e / CELL_DEG); lng++) {
      out.push([lat, lng]);
    }
  }
  return out;
}

function lineBbox(coords: LngLat[]): Bbox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Merge cells into ResortData, keeping only features that touch `bbox`. */
export function assembleResort(cells: Cell[], bbox: Bbox): ResortData {
  const runs = new Map<string, SkiRun>();
  const lifts = new Map<string, SkiLift>();

  for (const cell of cells) {
    for (const r of cell.runs) {
      const parts = r.g ?? r.p ?? [];
      parts.forEach((coords, i) => {
        if (coords.length < 2 || !intersects(lineBbox(coords), bbox)) return;
        const id = parts.length > 1 ? `${r.id}:${i}` : r.id;
        if (runs.has(id)) return;
        runs.set(id, {
          id,
          name: r.n ?? undefined,
          difficulty: r.d && DIFFICULTIES.has(r.d) ? r.d : "unknown",
          convention: r.c,
          coords,
          isArea: r.p !== undefined,
          areas: r.a,
        });
      });
    }
    for (const l of cell.lifts) {
      l.g.forEach((coords, i) => {
        if (coords.length < 2 || !intersects(lineBbox(coords), bbox)) return;
        const id = l.g.length > 1 ? `${l.id}:${i}` : l.id;
        if (lifts.has(id)) return;
        lifts.set(id, {
          id,
          name: l.n ?? undefined,
          type: (LIFT_TYPES.has(l.t) ? l.t : "other") as LiftType,
          coords,
          areas: l.a,
        });
      });
    }
  }

  const runList = [...runs.values()];
  const liftList = [...lifts.values()];
  return {
    runs: runList,
    lifts: liftList,
    bbox,
    extent: extentOf([...runList, ...liftList]),
    convention: majorityConvention(runList),
  };
}

export async function loadResortData(bbox: Bbox): Promise<ResortData> {
  const cells = await Promise.all(cellsTouching(bbox).map(([lat, lng]) => fetchCell(lat, lng)));
  return assembleResort(cells, bbox);
}

function extentOf(features: Array<{ coords: LngLat[] }>): Bbox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) {
    const b = lineBbox(f.coords);
    if (b[0] < w) w = b[0];
    if (b[1] < s) s = b[1];
    if (b[2] > e) e = b[2];
    if (b[3] > n) n = b[3];
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

function majorityConvention(runs: SkiRun[]): RunConvention | null {
  const tally = new Map<RunConvention, number>();
  for (const r of runs) tally.set(r.convention, (tally.get(r.convention) ?? 0) + 1);
  let best: RunConvention | null = null;
  let bestCount = 0;
  for (const [c, n] of tally) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

// --- Search ---

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Rank ski areas by name match: exact, prefix, word prefix, substring. */
export function searchIndex(index: Index, query: string, limit = 8): SkiAreaHit[] {
  const q = fold(query);
  if (!q) return [];
  const scored: Array<{ score: number; area: IndexArea }> = [];
  for (const area of index.areas) {
    const name = fold(area.n);
    let score: number;
    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.split(/[\s-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 1;
    else continue;
    scored.push({ score, area });
  }
  // The index is already sorted by run count, so a stable sort by score
  // keeps the bigger resort first within a tier.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ area }) => ({
    id: area.id,
    name: area.n,
    location: area.loc,
    countryCode: area.cc,
    convention: area.conv,
    center: [area.vh[0], area.vh[1]],
    bearing: area.vh[2],
    widthMeters: area.vh[3],
    heightMeters: area.vh[4],
    runCount: area.runs,
  }));
}

export async function searchSkiAreas(query: string, limit?: number): Promise<SkiAreaHit[]> {
  return searchIndex(await fetchIndex(), query, limit);
}
