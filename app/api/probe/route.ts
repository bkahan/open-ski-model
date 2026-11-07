// Temporary diagnostics: how do the Overpass mirrors respond from this
// deployment's network? GET /api/probe runs the variants below in
// parallel and returns timings plus the first bytes of each body.

import { NextResponse } from "next/server";

import { buildOverpassQuery } from "@/lib/resort/overpass";

export const runtime = "nodejs";
export const maxDuration = 30;

const TIMEOUT_MS = 12_000;
const BBOX: [number, number, number, number] = [-72.55, 44.9, -72.45, 44.96];

interface Probe {
  name: string;
  url: string;
  init?: RequestInit;
}

export async function GET() {
  const query = buildOverpassQuery(BBOX);
  const tiny = "[out:json][timeout:5];node(44.93,-72.51,44.94,-72.50);out 1;";
  const ua = "open-ski-model-probe (https://github.com/bkahan/open-ski-model)";

  const probes: Probe[] = [
    { name: "egress example.com", url: "https://example.com/" },
    { name: "status overpass-api.de", url: "https://overpass-api.de/api/status" },
    { name: "status private.coffee", url: "https://overpass.private.coffee/api/status" },
    {
      name: "tiny GET overpass-api.de",
      url: `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(tiny)}`,
    },
    {
      name: "tiny GET private.coffee",
      url: `https://overpass.private.coffee/api/interpreter?data=${encodeURIComponent(tiny)}`,
    },
    {
      name: "full POST form overpass-api.de",
      url: "https://overpass-api.de/api/interpreter",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
        body: `data=${encodeURIComponent(query)}`,
      },
    },
    {
      name: "full POST raw private.coffee",
      url: "https://overpass.private.coffee/api/interpreter",
      init: { method: "POST", headers: { "User-Agent": ua }, body: query },
    },
    {
      name: "full GET mail.ru",
      url: `https://maps.mail.ru/osm/tools/overpass/api/interpreter?data=${encodeURIComponent(query)}`,
    },
  ];

  const results = await Promise.all(
    probes.map(async (p) => {
      const t0 = Date.now();
      try {
        const res = await fetch(p.url, { ...p.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await res.text();
        return {
          name: p.name,
          ms: Date.now() - t0,
          status: res.status,
          bytes: text.length,
          head: text.slice(0, 160).replace(/\s+/g, " "),
        };
      } catch (err) {
        return {
          name: p.name,
          ms: Date.now() - t0,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
      }
    }),
  );

  console.log("[probe]", JSON.stringify(results));
  return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, results });
}
