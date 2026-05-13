// Bounding-box math.
//
// We use a small-angle approximation (good for any bbox smaller than ~100 km,
// which covers every ski resort on Earth comfortably): 1° of latitude is
// ~111,320 m, and 1° of longitude shrinks as cos(latitude).
//
// Think of it as: latitude lines are evenly spaced like rungs on a ladder, but
// longitude lines are like orange slices that get squeezed together near the
// poles.

import type { Bbox, LngLat } from "./types";

const METERS_PER_DEG_LAT = 111_320;

export function metersPerDegLng(latitudeDeg: number): number {
  return METERS_PER_DEG_LAT * Math.cos((latitudeDeg * Math.PI) / 180);
}

/**
 * Build a bbox from a center point and a desired width in meters, locked to
 * the given aspect ratio (width / height).
 */
export function bboxFromCenter(
  center: LngLat,
  widthMeters: number,
  aspect: number,
): Bbox {
  const [lng, lat] = center;
  const heightMeters = widthMeters / aspect;
  const dLat = heightMeters / 2 / METERS_PER_DEG_LAT;
  const dLng = widthMeters / 2 / metersPerDegLng(lat);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** Build a bbox from a center and explicit width/height in meters. */
export function bboxFromCenterWH(
  center: LngLat,
  widthMeters: number,
  heightMeters: number,
): Bbox {
  const [lng, lat] = center;
  const dLat = heightMeters / 2 / METERS_PER_DEG_LAT;
  const dLng = widthMeters / 2 / metersPerDegLng(lat);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export function bboxCenter(b: Bbox): LngLat {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Approximate width of the bbox in meters (uses center latitude). */
export function bboxWidthMeters(b: Bbox): number {
  const lat = (b[1] + b[3]) / 2;
  return (b[2] - b[0]) * metersPerDegLng(lat);
}

/** Approximate height of the bbox in meters. */
export function bboxHeightMeters(b: Bbox): number {
  return (b[3] - b[1]) * METERS_PER_DEG_LAT;
}

/** Clamp bbox to valid WGS84 bounds. */
export function clampBbox(b: Bbox): Bbox {
  return [
    Math.max(-180, b[0]),
    Math.max(-85, b[1]),
    Math.min(180, b[2]),
    Math.min(85, b[3]),
  ];
}

/**
 * Given a Nominatim bounding box (often very loose), expand it to the desired
 * aspect and a sensible default size, while keeping it centered on the result.
 */
export function snapBboxToAspect(
  source: Bbox,
  aspect: number,
  fallbackWidthMeters = 5_000,
): Bbox {
  const center = bboxCenter(source);
  const srcW = bboxWidthMeters(source);
  const srcH = bboxHeightMeters(source);
  // Use the larger of source dimensions or fallback so we always show meaningful terrain.
  const w = Math.max(srcW, srcH * aspect, fallbackWidthMeters);
  return bboxFromCenter(center, w, aspect);
}
