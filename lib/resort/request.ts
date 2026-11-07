// Request validation for /api/resort, kept out of the route file so it
// can be unit tested (Next only allows HTTP handlers as route exports).

import type { Bbox } from "@/lib/types";

/** Per-side cap on the fetch area, in degrees. Mirrored in app/page.tsx. */
export const MAX_BBOX_DEG = 0.5;

/** Grid the bbox is snapped to before fetching, so nearby frames share a call. */
export const SNAP_DEG = 0.01;

export function parseResortRequest(input: unknown): Bbox | string {
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
  if (e - w > MAX_BBOX_DEG || n - s > MAX_BBOX_DEG) {
    return `bbox too large (max ${MAX_BBOX_DEG}° per side)`;
  }
  return [w, s, e, n];
}

/** Expand a bbox to the enclosing cell corners of a `step`-degree grid. */
export function snapBboxOutward(b: Bbox, step: number = SNAP_DEG): Bbox {
  // The epsilon keeps 44.95 / 0.01 = 4495.0000000001 from snapping a
  // whole cell outward.
  const eps = 1e-9;
  const down = (v: number) => Number((Math.floor(v / step + eps) * step).toFixed(6));
  const up = (v: number) => Number((Math.ceil(v / step - eps) * step).toFixed(6));
  return [down(b[0]), down(b[1]), up(b[2]), up(b[3])];
}
