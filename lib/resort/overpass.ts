// Fetch downhill runs and lifts from OpenStreetMap via the Overpass API.
// Server-side only: the public Overpass endpoints rate-limit per IP and
// want a stable User-Agent, which we control here but not in the browser.

import type { Bbox, LngLat } from "@/lib/types";
import type {
  LiftType,
  ResortData,
  RunDifficulty,
  SkiLift,
  SkiRun,
} from "./types";

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT_S = 25;

const DIFFICULTIES: RunDifficulty[] = [
  "novice",
  "easy",
  "intermediate",
  "advanced",
  "expert",
  "freeride",
  "extreme",
];

const LIFT_TYPES: LiftType[] = [
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
];

// Lifts that don't carry skiers uphill on a run (goods lifts, zip lines,
// the station nodes themselves) are excluded.
const EXCLUDED_AERIALWAYS = new Set(["goods", "zip_line", "station", "pylon"]);

export interface OverpassElement {
  type: "way" | "node" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassResponse {
  elements: OverpassElement[];
  /** Set on HTTP 200 when the query timed out or ran out of memory. */
  remark?: string;
}

export function buildOverpassQuery(bbox: Bbox): string {
  const [w, s, e, n] = bbox;
  const box = `${s},${w},${n},${e}`;
  return `
[out:json][timeout:${OVERPASS_TIMEOUT_S}];
(
  way["piste:type"="downhill"](${box});
  way["aerialway"](${box});
);
out tags geom;
`.trim();
}

export async function fetchResortData(bbox: Bbox): Promise<ResortData> {
  const url = process.env.OVERPASS_URL ?? DEFAULT_OVERPASS_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `${process.env.NEXT_PUBLIC_APP_NAME ?? "open-ski-model"} (${process.env.NEXT_PUBLIC_APP_CONTACT ?? "https://github.com/bkahan/open-ski-model"})`,
    },
    body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}`,
    signal: AbortSignal.timeout((OVERPASS_TIMEOUT_S + 3) * 1000),
  });
  if (!res.ok) {
    throw new Error(`Overpass ${res.status}${res.status === 429 ? " (rate limited, retry shortly)" : ""}`);
  }
  const json = (await res.json()) as OverpassResponse;
  if (json.remark && /error/i.test(json.remark)) {
    throw new Error(`Overpass: ${json.remark}`);
  }
  return parseOverpass(json.elements ?? [], bbox);
}

export function parseOverpass(elements: OverpassElement[], bbox: Bbox): ResortData {
  const runs: SkiRun[] = [];
  const lifts: SkiLift[] = [];

  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const coords: LngLat[] = el.geometry.map((p) => [p.lon, p.lat]);

    if (tags["piste:type"] === "downhill") {
      runs.push({
        id: el.id,
        name: tags["piste:name"] ?? tags.name,
        difficulty: parseDifficulty(tags["piste:difficulty"]),
        coords,
        isArea: isClosedArea(tags, coords),
      });
      continue;
    }

    const aerialway = tags.aerialway;
    if (aerialway && !EXCLUDED_AERIALWAYS.has(aerialway)) {
      lifts.push({
        id: el.id,
        name: tags.name,
        type: parseLiftType(aerialway),
        coords,
      });
    }
  }

  return { runs, lifts, bbox, extent: extentOf([...runs, ...lifts]) };
}

function isDifficulty(raw: string): raw is RunDifficulty {
  return (DIFFICULTIES as readonly string[]).includes(raw);
}

function isLiftType(raw: string): raw is LiftType {
  return (LIFT_TYPES as readonly string[]).includes(raw);
}

function parseDifficulty(raw: string | undefined): RunDifficulty {
  return raw && isDifficulty(raw) ? raw : "unknown";
}

function parseLiftType(raw: string): LiftType {
  return isLiftType(raw) ? raw : "other";
}

function isClosedArea(tags: Record<string, string>, coords: LngLat[]): boolean {
  const first = coords[0];
  const last = coords[coords.length - 1];
  const closed = first[0] === last[0] && first[1] === last[1];
  return closed && (tags["area:piste"] === "yes" || tags.area === "yes");
}

function extentOf(features: Array<{ coords: LngLat[] }>): Bbox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const f of features) {
    for (const [lng, lat] of f.coords) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
