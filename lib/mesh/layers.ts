// The stacked finish: terrain rebuilt as flat elevation steps, like a
// laser-cut contour model. Each step is the terrain's own cross-section
// at that height, so a step follows the real contour and keeps whatever
// footprint the model was cut to.

import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";

import { pipeSections } from "./silhouette";

const MM_PER_INCH = 25.4;

export const DEFAULT_LAYER_COUNT = 8;
export const MIN_LAYER_COUNT = 3;
export const MAX_LAYER_COUNT = 16;

/** Step heights are whole multiples of this, so every step ends on a print layer. */
const PRINT_LAYER_IN = 0.2 / MM_PER_INCH;
/** Slivers and pinholes narrower than twice this won't survive printing. */
const SMOOTHING_RADIUS_IN = 0.5 / MM_PER_INCH;
const MIN_ISLAND_AREA_IN2 = 6 / (MM_PER_INCH * MM_PER_INCH);
const ARC_SEGMENTS = 24;
const SIMPLIFY_IN = 0.1 / MM_PER_INCH;

export interface TerrainLayers {
  /** Step boundaries in y, lowest first; layer k runs from levels[k] to levels[k + 1]. */
  levels: number[];
  /** Top of the solid base under the terrain surface. */
  baseY: number;
}

/** Evenly spaced step boundaries from the lowest surface point up. */
export function layerLevels(lowY: number, highY: number, count: number): number[] {
  const printLayers = Math.max(1, Math.round((highY - lowY) / count / PRINT_LAYER_IN));
  const step = printLayers * PRINT_LAYER_IN;
  return Array.from({ length: count + 1 }, (_, k) => lowY + k * step);
}

/** The flat top that a point on the smooth surface lands on. */
export function layerTopAt(levels: number[], y: number): number {
  for (let k = 1; k < levels.length; k++) {
    if (y < levels[k]) return levels[k];
  }
  return levels[levels.length - 1];
}

function withoutSmallIslands(m: ManifoldToplevel, section: CrossSection): CrossSection {
  const parts = section.decompose();
  try {
    return m.CrossSection.compose(parts.filter((p) => p.area() >= MIN_ISLAND_AREA_IN2));
  } finally {
    for (const p of parts) p.delete();
  }
}

/** The contour at one height, tidied up so it can be printed. */
function cleanContour(m: ManifoldToplevel, slice: CrossSection, below: CrossSection): CrossSection {
  const r = SMOOTHING_RADIUS_IN;
  return pipeSections(slice, [
    // Each offset adds an arc at every vertex, so a raw slice has to be
    // thinned first or the vertex count explodes.
    (s) => s.simplify(SIMPLIFY_IN),
    (s) => s.offset(r, "Round", 2, ARC_SEGMENTS),
    (s) => s.offset(-2 * r, "Round", 2, ARC_SEGMENTS),
    (s) => s.offset(r, "Round", 2, ARC_SEGMENTS),
    (s) => s.simplify(SIMPLIFY_IN),
    (s) => withoutSmallIslands(m, s),
    // Smoothing can nudge an edge past the step below, which would overhang.
    (s) => s.intersect(below),
  ]);
}

function prismToHeight(section: CrossSection, height: number): Manifold {
  const extruded = section.extrude(height);
  try {
    return extruded.rotate([-90, 0, 0]);
  } finally {
    extruded.delete();
  }
}

/**
 * Replace a terrain solid with its stacked version. Each step is a solid
 * column from y = 0, so neighbors overlap instead of merely touching.
 * The caller owns the result; `terrain` is left alone.
 */
export function stackTerrain(
  m: ManifoldToplevel,
  terrain: Manifold,
  { levels, baseY }: TerrainLayers,
): Manifold {
  // Standing the model on end makes model y the slicing axis. Sections
  // come out as (x, -z), which rotating back undoes.
  const upright = terrain.rotate([90, 0, 0]);
  const columns: Manifold[] = [];
  let below: CrossSection | null = null;
  try {
    for (let k = 0; k + 1 < levels.length; k++) {
      // Layer 0 is the whole footprint, read mid-base where it is clean.
      const slice = upright.slice(k === 0 ? baseY / 2 : levels[k]);
      const contour: CrossSection = below ? cleanContour(m, slice, below) : slice;
      below?.delete();
      below = contour;
      if (contour.isEmpty()) break;
      columns.push(prismToHeight(contour, levels[k + 1]));
    }
    return m.Manifold.union(columns);
  } finally {
    upright.delete();
    below?.delete();
    for (const c of columns) c.delete();
  }
}
