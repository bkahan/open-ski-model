// POST /api/elevation
//
// Body:  { bbox, gridSize, source? }
// where source ∈ "auto" | "terrarium" | "usgs" (default "auto").
//   - "terrarium": always use AWS terrain tiles (global, 30m).
//   - "usgs":      always use USGS 3DEP exportImage (best in the US).
//   - "auto":      pick USGS for bboxes fully inside the US, else terrarium.
//                  Falls back to terrarium if USGS errors.
//
// Runs on the Node runtime (Buffer + pngjs + geotiff). Maxes out at 30s.

import { NextResponse } from "next/server";

import { buildHeightGrid } from "@/lib/elevation/terrarium";
import { bboxLikelyInUS, buildHeightGridUSGS } from "@/lib/elevation/usgs";
import type {
  ElevationRequest,
  ElevationResponse,
  ElevationSource,
} from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: ElevationRequest;
  try {
    body = (await req.json()) as ElevationRequest;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const validation = validate(body);
  if (validation) return json({ error: validation }, 400);

  const source: ElevationSource = body.source ?? "auto";
  const useUSGS =
    source === "usgs" || (source === "auto" && bboxLikelyInUS(body.bbox));

  try {
    let result: ElevationResponse;
    if (useUSGS) {
      try {
        result = await buildHeightGridUSGS(body.bbox, body.gridSize);
      } catch (err) {
        // "auto" silently falls back. Explicit "usgs" surfaces the error.
        if (source === "usgs") throw err;
        console.warn("[elevation] USGS failed, falling back to terrarium", err);
        result = await buildHeightGrid(body.bbox, body.gridSize);
      }
    } else {
      result = await buildHeightGrid(body.bbox, body.gridSize);
    }
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=3600",
      },
    });
  } catch (err) {
    console.error("[/api/elevation] failed", err);
    return json(
      { error: err instanceof Error ? err.message : "unknown error" },
      500,
    );
  }
}

function validate(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return "body must be an object";
  const b = input as Record<string, unknown>;

  if (!Array.isArray(b.bbox) || b.bbox.length !== 4) return "bbox must be [w,s,e,n]";
  const raw = b.bbox as unknown[];
  if (raw.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return "bbox values must be finite numbers";
  }
  const [w, s, e, n] = raw as Bbox;
  if (w < -180 || e > 180 || s < -85 || n > 85) return "bbox out of range";
  if (w >= e || s >= n) return "bbox W/S must be less than E/N";
  if (e - w > 5 || n - s > 5) return "bbox too large (max 5° per side)";

  if (typeof b.gridSize !== "number" || b.gridSize < 16 || b.gridSize > 512) {
    return "gridSize must be a number 16..512";
  }

  if (
    b.source !== undefined &&
    b.source !== "auto" &&
    b.source !== "terrarium" &&
    b.source !== "usgs"
  ) {
    return "source must be one of auto|terrarium|usgs";
  }

  return null;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}
