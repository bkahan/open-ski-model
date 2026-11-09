// The stacked finish: terrain rebuilt as flat elevation steps, like a
// laser-cut contour model. Each step is the terrain's own cross-section
// at that height, so a step follows the real contour and keeps whatever
// footprint the model was cut to. Runs and lifts are cut into the flat
// tops as grooves that can be seen and painted.

import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";

import { pipeSections, thinnedLine } from "./silhouette";
import type { Contour } from "./text";

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
const MAX_GROOVE_DEPTH_IN = 1 / MM_PER_INCH;
const GROOVE_POINT_SPACING_IN = 0.02;
const GROOVE_JOINT_SIDES = 12;

export interface GroovePath {
  /** Polyline in the model plane: x east, z north, inches. */
  points: Array<[number, number]>;
  halfWidth: number;
}

export interface TerrainLayers {
  /** Step boundaries in y, lowest first; layer k runs from levels[k] to levels[k + 1]. */
  levels: number[];
  /** Top of the solid base under the terrain surface. */
  baseY: number;
  /** Runs and lifts to cut into the flat tops. */
  grooves?: GroovePath[];
}

/** Evenly spaced step boundaries from the lowest surface point up. */
export function layerLevels(lowY: number, highY: number, count: number): number[] {
  const printLayers = Math.max(1, Math.round((highY - lowY) / count / PRINT_LAYER_IN));
  const step = printLayers * PRINT_LAYER_IN;
  return Array.from({ length: count + 1 }, (_, k) => lowY + k * step);
}

/** Groove depth for these steps: at most half a step, in whole print layers. */
export function grooveDepthFor(levels: number[]): number {
  const halfStep = (levels[1] - levels[0]) / 2;
  const printLayers = Math.floor(Math.min(MAX_GROOVE_DEPTH_IN, halfStep) / PRINT_LAYER_IN + 1e-9);
  return Math.max(1, printLayers) * PRINT_LAYER_IN;
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

/**
 * Every path as round-jointed strips, in the (x, -z) plane of the slices.
 * Built as one polygon soup because offsetting this many vertices is slow.
 */
function grooveSection(m: ManifoldToplevel, paths: GroovePath[]): CrossSection {
  const polygons: Contour[] = [];
  for (const { points, halfWidth } of paths) {
    const line = thinnedLine(points, GROOVE_POINT_SPACING_IN).map(
      ([x, z]): [number, number] => [x, -z],
    );
    line.forEach(([x, y], i) => {
      polygons.push(
        Array.from({ length: GROOVE_JOINT_SIDES }, (_, side): [number, number] => {
          const a = (side / GROOVE_JOINT_SIDES) * Math.PI * 2;
          return [x + halfWidth * Math.cos(a), y + halfWidth * Math.sin(a)];
        }),
      );
      if (i + 1 === line.length) return;
      const [nextX, nextY] = line[i + 1];
      const length = Math.hypot(nextX - x, nextY - y);
      if (length === 0) return;
      const nx = (-(nextY - y) / length) * halfWidth;
      const ny = ((nextX - x) / length) * halfWidth;
      polygons.push([
        [x - nx, y - ny],
        [nextX - nx, nextY - ny],
        [nextX + nx, nextY + ny],
        [x + nx, y + ny],
      ]);
    });
  }
  return new m.CrossSection(polygons, "NonZero");
}

function prismToHeight(section: CrossSection, height: number): Manifold {
  const extruded = section.extrude(height);
  try {
    return extruded.rotate([-90, 0, 0]);
  } finally {
    extruded.delete();
  }
}

/** Solid columns for one step: full height, with the groove left out of the top. */
function stepColumns(
  contour: CrossSection,
  above: CrossSection | null,
  grooves: CrossSection | null,
  top: number,
  depth: number,
): Manifold[] {
  if (!grooves) return [prismToHeight(contour, top)];
  const sections: CrossSection[] = [];
  const held = (section: CrossSection) => {
    sections.push(section);
    return section;
  };
  const columns: Manifold[] = [];
  try {
    // Only the part of this step left uncovered by the next one gets cut:
    // a groove here must not run through the solid under the step above.
    const exposed = above ? held(contour.subtract(above)) : contour;
    const cut = held(exposed.intersect(grooves));
    if (cut.isEmpty()) {
      columns.push(prismToHeight(contour, top));
      return columns;
    }
    columns.push(prismToHeight(contour, top - depth));
    columns.push(prismToHeight(held(contour.subtract(cut)), top));
    return columns;
  } catch (err) {
    for (const c of columns) c.delete();
    throw err;
  } finally {
    for (const s of sections) s.delete();
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
  { levels, baseY, grooves }: TerrainLayers,
): Manifold {
  // Standing the model on end makes model y the slicing axis. Sections
  // come out as (x, -z), which rotating back undoes.
  const upright = terrain.rotate([90, 0, 0]);
  const contours: CrossSection[] = [];
  const columns: Manifold[] = [];
  let grooveCut: CrossSection | null = null;
  try {
    for (let k = 0; k + 1 < levels.length; k++) {
      // Layer 0 is the whole footprint, read mid-base where it is clean.
      const slice = upright.slice(k === 0 ? baseY / 2 : levels[k]);
      const below = contours[contours.length - 1];
      const contour: CrossSection = below ? cleanContour(m, slice, below) : slice;
      if (contour.isEmpty()) {
        contour.delete();
        break;
      }
      contours.push(contour);
    }

    grooveCut = grooves?.length ? grooveSection(m, grooves) : null;
    const depth = grooveDepthFor(levels);
    contours.forEach((contour, k) => {
      columns.push(
        ...stepColumns(contour, contours[k + 1] ?? null, grooveCut, levels[k + 1], depth),
      );
    });
    return m.Manifold.union(columns);
  } finally {
    upright.delete();
    grooveCut?.delete();
    for (const c of contours) c.delete();
    for (const c of columns) c.delete();
  }
}
