// Reads the static ski dataset built by scripts/build-ski-data.mjs and
// published on the repo's `data` branch. Server-side only.
//
// The data is 1° cells of runs and lifts plus a ski-area index, fetched
// through jsDelivr's CDN. No query server is involved, which is the
// point: the public Overpass instances were rejecting even trivial
// queries under load.

import {
  cellsTouching,
  extentOf,
  fetchGzipJson,
  fetchRequiredJson,
  foldName,
  intersects,
  lineBbox,
  nameMatchScore,
} from "@/lib/data/static-data";
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

const EMPTY_CELL: Cell = { v: 1, runs: [], lifts: [] };

export async function fetchCell(lat: number, lng: number): Promise<Cell> {
  return (await fetchGzipJson<Cell>(`${dataBaseUrl()}/cells/${lat}/${lng}.json.gz`)) ?? EMPTY_CELL;
}

export function fetchIndex(): Promise<Index> {
  return fetchRequiredJson<Index>(`${dataBaseUrl()}/ski-areas.json`);
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
    extent: extentOf([...runList, ...liftList].map((line) => line.coords)),
    convention: majorityConvention(runList),
  };
}

export async function loadResortData(bbox: Bbox): Promise<ResortData> {
  const cells = await Promise.all(cellsTouching(bbox).map(([lat, lng]) => fetchCell(lat, lng)));
  return assembleResort(cells, bbox);
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

/** Rank ski areas by name match: exact, prefix, word prefix, substring. */
export function searchIndex(index: Index, query: string, limit = 8): SkiAreaHit[] {
  const q = foldName(query);
  if (!q) return [];
  const scored: Array<{ score: number; area: IndexArea }> = [];
  for (const area of index.areas) {
    const score = nameMatchScore(area.n, q);
    if (score > 0) scored.push({ score, area });
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
