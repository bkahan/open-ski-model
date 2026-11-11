// Fits the map frame to a ski area's actual runs and lifts. The index's
// natural viewport is only a starting point: it can sit off-center from
// the runs, and the model is cut to whatever the frame holds.

import { metersPerDegLng } from "@/lib/bbox";
import type { Bbox, LngLat } from "@/lib/types";

import type { ResortData } from "./types";

const METERS_PER_DEG_LAT = 111_320;
/** How far past the tagged lines an untagged one can start, as a share of their span. */
const UNTAGGED_REACH = 0.05;

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
 * The square frame, turned `rotationDeg` counter-clockwise, around the
 * lines tagged with `areaId` and the untagged lines that reach them.
 * Polygons are skipped: they aren't drawn, and
 * OSM often maps a whole backcountry zone as one. Null when nothing is tagged.
 */
export function frameAroundResort(
  resort: ResortData,
  areaId: string,
  rotationDeg: number,
  padding: number,
): ResortFrame | null {
  const drawn = [...resort.runs.filter((r) => !r.isArea), ...resort.lifts];
  const tagged = drawn.filter((line) => line.areas?.includes(areaId));
  if (tagged.length === 0) return null;

  // Many real runs carry no ski-area tag at all (Jay's glades don't). They
  // still end up on the model, so any that reach the resort count too.
  const reach = expandedBounds(tagged.flatMap((line) => line.coords), UNTAGGED_REACH);
  const untagged = drawn.filter(
    (line) => !line.areas?.length && line.coords.some((p) => isWithin(p, reach)),
  );
  const points = [...tagged, ...untagged].flatMap((line) => line.coords);

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
