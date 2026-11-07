// POST /api/resort
//
// Body: { bbox }
// Returns the ski runs and lifts inside the bbox from the static
// OpenSkiData cells (see lib/resort/skidata.ts), with the extent of
// everything found so the client can auto-frame.

import { NextResponse } from "next/server";

import { parseResortRequest } from "@/lib/resort/request";
import { loadResortData } from "@/lib/resort/skidata";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = parseResortRequest(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

  try {
    return NextResponse.json(await loadResortData(parsed));
  } catch (err) {
    console.error("[/api/resort] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
