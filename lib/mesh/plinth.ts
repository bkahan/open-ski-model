// Plinth: a chamfered base under the terrain. The top matches the model
// footprint; the bottom is the footprint offset outward by the rim
// width, and the 35° chamfer between them carries the name plate.
//
//            terrain (seated just below y = plinth height)
//           ┌──────────────────────┐   ← top outline = footprint
//          /      chamfer 35°       \
//         └──────────────────────────┘ ← bottom outline = footprint + rim
//
// All three footprints are convex, so the solid is simply the convex
// hull of the two outlines. Coordinates are the viewer's model frame:
// x east, y up, z north, inches.

import type { Manifold, ManifoldToplevel, Vec3 } from "manifold-3d";

import { shapeOutline, type Shape } from "@/lib/shape";

const MM_PER_INCH = 25.4;

export const BEVEL_DEG = 35;
/** Horizontal rim width; the plinth height follows from it and the angle. */
export const RIM_IN = 15 / MM_PER_INCH;

export interface PlinthSpec {
  shape: Shape;
  /** Shape pre-rotation dimensions in inches. */
  widthInches: number;
  heightInches: number;
  /** Degrees, same convention as shapeOutline. */
  rotation: number;
  rimInches?: number;
}

/**
 * The terrain's underside sits this far below the plinth's top, so ground
 * that meets the plinth at zero height still has full-depth color in it.
 */
export const TERRAIN_SEAT_IN = 1 / MM_PER_INCH;
/**
 * The plinth is recessed under the terrain to clear the color pockets
 * that reach below its top. Shallower and narrower than the seat, so
 * plinth and terrain overlap around it and no two faces coincide.
 */
export const SEAT_RECESS_DEPTH_IN = 0.8 / MM_PER_INCH;
export const SEAT_RECESS_INSET_IN = 0.25 / MM_PER_INCH;

export function plinthHeightInches(rimInches = RIM_IN): number {
  return rimInches * Math.tan((BEVEL_DEG * Math.PI) / 180);
}

/** Length of the chamfer face measured down the slope. */
export function chamferSlopeInches(rimInches = RIM_IN): number {
  return rimInches / Math.cos((BEVEL_DEG * Math.PI) / 180);
}

export function buildPlinthSolid(m: ManifoldToplevel, spec: PlinthSpec): Manifold {
  const { shape, widthInches, heightInches, rotation } = spec;
  const rim = spec.rimInches ?? RIM_IN;
  const h = plinthHeightInches(rim);

  const top = shapeOutline(shape, widthInches, heightInches, rotation);
  // Miter keeps rectangle and hexagon corners sharp; a circle's offset is
  // a circle either way.
  const section = new m.CrossSection([top], "Positive");
  const grown = section.offset(rim, "Miter", 4);
  const bottom = grown.toPolygons();
  section.delete();
  grown.delete();

  const points: Vec3[] = [];
  for (const [x, z] of top) points.push([x, h, z]);
  for (const ring of bottom) for (const [x, z] of ring) points.push([x, 0, z]);
  return m.Manifold.hull(points);
}
