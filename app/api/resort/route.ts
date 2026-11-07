// POST /api/resort
//
// Body: { bbox }
// Returns downhill runs and lifts from OpenStreetMap inside the bbox,
// with the extent of everything found so the client can auto-frame.
//
// The bbox is snapped outward to a coarse grid before it is keyed and
// fetched, so nearby frames share one Overpass call and a drag can't
// turn into a stream of distinct upstream requests. The response's
// `bbox` is the snapped one, which always contains what was asked for.

import { NextResponse } from "next/server";

import { fetchResortData } from "@/lib/resort/overpass";
import { parseResortRequest, snapBboxOutward } from "@/lib/resort/request";
import type { ResortData } from "@/lib/resort/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;

const cache = new Map<string, { at: number; data: ResortData }>();
const inFlight = new Map<string, Promise<ResortData>>();

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = parseResortRequest(body);
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  const bbox = snapBboxOutward(parsed);
  const key = bbox.join(",");

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);

  try {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchResortData(bbox).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const data = await pending;
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[/api/resort] failed", err);
    return json({ error: err instanceof Error ? err.message : "unknown error" }, 502);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}
