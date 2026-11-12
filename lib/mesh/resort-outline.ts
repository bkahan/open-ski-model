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

/** A traced ring as map coordinates. */
export function outlineOnMap(spec: FrameSpec, ring: Contour): LngLat[] {
  return planePointsOnMap(spec, ring);
}
