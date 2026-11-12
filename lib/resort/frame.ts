// Which lines are a ski area's, and the frame that fits them. The index's
// natural viewport is only a starting point: it can sit off-center from
// the runs. The frame and the outline both go by resortLines, so the
// outline can never reach past the frame it is traced in.

import { metersPerDegLng } from "@/lib/bbox";
import type { Bbox, LngLat } from "@/lib/types";

import type { ResortData, SkiLift, SkiRun } from "./types";

const METERS_PER_DEG_LAT = 111_320;
/** How far past the tagged lines an untagged one can start, as a share of their span. */
const UNTAGGED_REACH = 0.05;
/**
 * Padding for a frame the resort's outline is traced in. The outline
 * stands 3% of the frame's side off the outermost lines, so 12% of the
 * lines' span keeps it clear of the frame's edge with room to spare.
 */
export const OUTLINE_FRAME_PADDING = 1.12;

export interface ResortFrame {
  center: LngLat;
  /** Side of the square frame that holds the padded lines. */
  sideMeters: number;
}

function expandedBounds(points: LngLat[], fraction: number): Bbox {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const marginLng = (east - west) * fraction;
  const marginLat = (north - south) * fraction;
  return [west - marginLng, south - marginLat, east + marginLng, north + marginLat];
}

function isWithin([lng, lat]: LngLat, [west, south, east, north]: Bbox): boolean {
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

/**
 * The runs and lifts that make up ski area `areaId`: the lines tagged
 * with it, and the untagged lines that reach them. Many real runs carry
 * no ski-area tag at all (Jay's glades don't). Lines tagged only to
 * another area are a neighbor's, and polygons are skipped: they aren't
 * drawn, and OSM often maps a whole backcountry zone as one. Empty when
 * nothing is tagged.
 */
export function resortLines(resort: ResortData, areaId: string): Array<SkiRun | SkiLift> {
  const drawn = [...resort.runs.filter((r) => !r.isArea), ...resort.lifts];
  const tagged = drawn.filter((line) => line.areas?.includes(areaId));
  if (tagged.length === 0) return [];
  const reach = expandedBounds(tagged.flatMap((line) => line.coords), UNTAGGED_REACH);
  const untagged = drawn.filter(
    (line) => !line.areas?.length && line.coords.some((p) => isWithin(p, reach)),
  );
  return [...tagged, ...untagged];
}

/**
 * The square frame, turned `rotationDeg` counter-clockwise, around the
 * ski area's lines. Null when it has none.
 */
export function frameAroundResort(
  resort: ResortData,
  areaId: string,
  rotationDeg: number,
  padding: number,
): ResortFrame | null {
  const points = resortLines(resort, areaId).flatMap((line) => line.coords);
  if (points.length === 0) return null;

  const originLat = points[0][1];
  const originLng = points[0][0];
  const mPerDegLng = metersPerDegLng(originLat);
  const a = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [lng, lat] of points) {
    const x = (lng - originLng) * mPerDegLng;
    const y = (lat - originLat) * METERS_PER_DEG_LAT;
    const u = x * cos + y * sin;
    const v = -x * sin + y * cos;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;
  return {
    center: [
      originLng + (midU * cos - midV * sin) / mPerDegLng,
      originLat + (midU * sin + midV * cos) / METERS_PER_DEG_LAT,
    ],
    sideMeters: Math.max(maxU - minU, maxV - minV) * padding,
  };
}
