// GET /api/resort/search?q=jay
//
// Ski-area name search over the OpenSkiData index. Returns the natural
// viewport of each hit so the client can frame the whole resort.

import { NextResponse } from "next/server";

import { searchSkiAreas } from "@/lib/resort/skidata";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 80;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.slice(0, MAX_QUERY_CHARS) ?? "";
  if (q.trim().length < 2) return NextResponse.json({ results: [] });
  try {
    const results = await searchSkiAreas(q);
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" } },
    );
  } catch (err) {
    console.error("[/api/resort/search] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
