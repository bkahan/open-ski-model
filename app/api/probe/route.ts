// Temporary diagnostics: how do the Overpass mirrors respond from this
// deployment's network? GET /api/probe runs the variants below in
// parallel and returns timings plus the first bytes of each body.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const TIMEOUT_MS = 5_000;

interface Probe {
  name: string;
  url: string;
  init?: RequestInit;
}

export async function GET() {
  const ua = "open-ski-model-probe (https://github.com/bkahan/open-ski-model)";

  const box = "44.9,-72.55,44.96,-72.45";
  const q = (body: string) => `[out:json][timeout:10];${body}`;
  const variants: Record<string, string> = {
    tiny: q(`node(${box});out 1;`),
    pisteOnly: q(`way["piste:type"="downhill"](${box});out tags geom;`),
    liftOnly: q(`way["aerialway"](${box});out tags geom;`),
    liftKeyed: q(`way["aerialway"~"^(chair_lift|gondola|cable_car|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet)$"](${box});out tags geom;`),
    pisteIds: q(`way["piste:type"="downhill"](${box});out ids;`),
  };
  const hosts: Record<string, string> = {
    de: "https://overpass-api.de/api/interpreter",
    coffee: "https://overpass.private.coffee/api/interpreter",
  };
  const run = async (p: Probe) => {
    const t0 = Date.now();
    try {
      const res = await fetch(p.url, { ...p.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      return {
        name: p.name,
        ms: Date.now() - t0,
        status: res.status,
        bytes: text.length,
        head: text.slice(0, 120).replace(/\s+/g, " "),
      };
    } catch (err) {
      return {
        name: p.name,
        ms: Date.now() - t0,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  };

  // One query at a time per host (Overpass limits concurrent slots per
  // IP); hosts in parallel.
  const perHost = Object.entries(hosts).map(async ([hostName, url]) => {
    const out = [];
    for (const [name, data] of Object.entries(variants)) {
      out.push(
        await run({
          name: `${name} ${hostName}`,
          url,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
            body: `data=${encodeURIComponent(data)}`,
          },
        }),
      );
    }
    return out;
  });
  const results = (await Promise.all(perHost)).flat();

  console.log("[probe]", JSON.stringify(results));
  return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, results });
}
