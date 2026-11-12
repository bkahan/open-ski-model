// The one place a resort's outline is traced. The map draws this ring and
// the model is cut to it, so what is shown is what prints.

import type { ManifoldToplevel } from "manifold-3d";

import type { ResortData } from "@/lib/resort/types";
import { shapeAABBHalf, shapeOutline } from "@/lib/shape";
import type { LngLat } from "@/lib/types";

import { planePointsOnMap, resortLinesOnPlane, type FrameSpec } from "./runs";
import { buildResortOutline } from "./silhouette";
import type { Contour } from "./text";

export interface OutlineSpec extends FrameSpec {
  resort: ResortData;
  /** The ski area the outline is of; without one, every line in the frame counts. */
  areaId?: string | null;
  /**
   * Also take untagged lines that only join the ski area's further out
   * (resortLines). Must be what the frame was fitted with.
   */
  followConnected: boolean;
  /** Columns of the elevation grid the frame is sampled on. */
  gridColumns: number;
}

/**
 * The ring around the resort's runs and lifts, in the model plane. It is
 * held one grid cell inside the frame: the terrain's outermost row is the
 * frame's wall, and a cut along it would leave slivers.
 */
export function traceResortOutline(m: ManifoldToplevel, spec: OutlineSpec): Contour | null {
  const [halfWidth] = shapeAABBHalf(spec.shape, spec.widthInches, spec.heightInches, spec.rotation);
  const cell = (halfWidth * 2) / (spec.gridColumns - 1);
  return buildResortOutline(
    m,
    resortLinesOnPlane(spec),
    shapeOutline(spec.shape, spec.widthInches - 2 * cell, spec.heightInches - 2 * cell, spec.rotation),
    Math.max(spec.widthInches, spec.heightInches),
  );
}

/**
 * A rough outlineShare for before a resort has been traced: lines that
 * fill a frame padded 12%, plus the outline's 3% margin on each side.
 */
export const ESTIMATED_OUTLINE_SHARE = 0.95;

/**
 * The outline's longest side, measured square to its frame, as a share of
 * the frame's side. The outline is built in proportion to the frame, so
 * the share holds at any print size and turns "the mountain is 6 in" into
 * the frame to build. Null for a ring with no extent.
 */
export function outlineShare(spec: FrameSpec, ring: Contour): number | null {
  // The frame's own edges give its axes, whichever way it is turned.
  const [origin, alongWidth, , alongHeight] = shapeOutline("rectangle", 1, 1, spec.rotation);
  const axes = [alongWidth, alongHeight].map(([x, z]) => [x - origin[0], z - origin[1]]);
  let longest = 0;
  for (const [ax, az] of axes) {
    let least = Infinity;
    let most = -Infinity;
    for (const [x, z] of ring) {
      const along = x * ax + z * az;
      least = Math.min(least, along);
      most = Math.max(most, along);
    }
    longest = Math.max(longest, most - least);
  }
  const share = longest / Math.max(spec.widthInches, spec.heightInches);
  return Number.isFinite(share) && share > 0 ? share : null;
}

/** A traced ring as map coordinates. */
export function outlineOnMap(spec: FrameSpec, ring: Contour): LngLat[] {
  return planePointsOnMap(spec, ring);
}
