// Shared plumbing for the static datasets published on the repo's data
// branches (ski and hiking): cached fetches, 1° cell math, name search.
// Server-side only.

import { gunzipSync } from "node:zlib";

import type { Bbox, LngLat } from "@/lib/types";

export const CELL_DEG = 1;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const FETCH_TIMEOUT_MS = 15_000;

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

/** A gzipped JSON file, cached; null when the data branch has no such file. */
export function fetchGzipJson<T>(url: string): Promise<T | null> {
  return cached(url, async () => {
    const bytes = await fetchBytes(url);
    return bytes ? (JSON.parse(gunzipSync(Buffer.from(bytes)).toString("utf8")) as T) : null;
  });
}

/** A plain JSON file, cached; null when the data branch has no such file. */
export function fetchJson<T>(url: string): Promise<T | null> {
  return cached(url, async () => {
    const bytes = await fetchBytes(url);
    return bytes ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as T) : null;
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

export function lineBbox(coords: LngLat[]): Bbox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

export function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** The bbox around every line, or null when there are none. */
export function extentOf(lines: LngLat[][]): Bbox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const line of lines) {
    const b = lineBbox(line);
    if (b[0] < w) w = b[0];
    if (b[1] < s) s = b[1];
    if (b[2] > e) e = b[2];
    if (b[3] > n) n = b[3];
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * How well a name matches a folded query: 4 exact, 3 prefix, 2 a word's
 * prefix, 1 substring, 0 no match.
 */
export function nameMatchScore(name: string, foldedQuery: string): number {
  const folded = foldName(name);
  if (folded === foldedQuery) return 4;
  if (folded.startsWith(foldedQuery)) return 3;
  if (folded.split(/[\s-]+/).some((word) => word.startsWith(foldedQuery))) return 2;
  if (folded.includes(foldedQuery)) return 1;
  return 0;
}
