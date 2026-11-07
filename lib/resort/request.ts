// Request validation for /api/resort, kept out of the route file so it
// can be unit tested (Next only allows HTTP handlers as route exports).

import type { Bbox } from "@/lib/types";

/** Per-side cap on the fetch area, in degrees. Mirrored in app/page.tsx. */
export const MAX_BBOX_DEG = 0.5;

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
