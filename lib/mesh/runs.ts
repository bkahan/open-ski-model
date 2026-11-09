// Drape ski runs and lifts onto the terrain as flat ribbons.
//
// Each polyline is converted from lng/lat to model-plane inches, densified
// to roughly one sample per grid cell so it follows the surface, then
// extruded sideways into a strip whose height is read off the height grid.
// Runs that share a color are merged into one VertexData: that grouping is
// exactly what becomes one filament body for multicolor export.
//
// Widths are clamped to a printable minimum. A 10 m cat track at 1:20,000
// is 0.5 mm wide, below what a nozzle can resolve, so anything narrower
// than `minWidthMm` is widened to it.

import { VertexData } from "@babylonjs/core";

import { bboxCenter, bboxWidthMeters, metersPerDegLng } from "@/lib/bbox";
import type { ElevationResponse } from "@/lib/elevation/types";
import { liftColor, runColor, type ColorScheme, type Rgb } from "@/lib/resort/colors";
import { layerLevels, layerTopAt, type TerrainLayers } from "@/lib/mesh/layers";
import { frontBearing } from "@/lib/resort/front";
import type { ResortData } from "@/lib/resort/types";
import { pointInShape, shapeAABBHalf, type Shape } from "@/lib/shape";
import type { Bbox, LngLat } from "@/lib/types";

const METERS_PER_DEG_LAT = 111_320;
const MM_PER_INCH = 25.4;

/** Real-world widths assumed when OSM doesn't say (it rarely does). */
const DEFAULT_RUN_WIDTH_M = 30;
const DEFAULT_LIFT_WIDTH_M = 8;

export interface RunMeshSpec {
  bbox: Bbox;
  data: ElevationResponse;
  shape: Shape;
  /** Shape pre-rotation dimensions in inches. */
  widthInches: number;
  heightInches: number;
  rotation: number;
  baseThicknessInches: number;
  verticalExaggeration: number;
  resort: ResortData;
  scheme: ColorScheme;
  showLifts: boolean;
  /** Printable minimum ribbon width. */
  minWidthMm: number;
  /** How far above the terrain surface the ribbon floats, in inches. */
  lift: number;
  /** Extra footprint test, for a model cut to something other than its shape. */
  insideOutline?: (x: number, z: number) => boolean;
  /** Step boundaries, when the terrain is stacked; ribbons sit on the flat tops. */
  layerLevels?: number[];
}

export interface RibbonGroup {
  /** Color name from the scheme ("green", "black", "lift", ...). */
  name: string;
  rgb: Rgb;
  vertexData: VertexData;
  /** Number of runs or lifts merged into this group. */
  count: number;
}

interface Builder {
  positions: number[];
  indices: number[];
  count: number;
}

/** The inputs that fix how lng/lat maps onto the model plane. */
export type PlaneSpec = Pick<
  RunMeshSpec,
  "bbox" | "data" | "shape" | "widthInches" | "heightInches" | "rotation"
>;

interface Plane {
  geoToLocal: (p: LngLat) => [number, number];
  /** Full extent of the elevation grid in inches (the rotated shape's AABB). */
  gridW: number;
  gridH: number;
  inPerMeter: number;
}

function modelPlane(spec: PlaneSpec): Plane {
  const { bbox, shape, widthInches, heightInches, rotation } = spec;
  const [aabbHalfW, aabbHalfH] = shapeAABBHalf(shape, widthInches, heightInches, rotation);
  const gridW = aabbHalfW * 2;
  const gridH = aabbHalfH * 2;
  const inPerMeter = gridW / bboxWidthMeters(bbox);
  const center = bboxCenter(bbox);
  const mPerDegLng = metersPerDegLng(center[1]);
  return {
    geoToLocal: ([lng, lat]) => [
      (lng - center[0]) * mPerDegLng * inPerMeter,
      (lat - center[1]) * METERS_PER_DEG_LAT * inPerMeter,
    ],
    gridW,
    gridH,
    inPerMeter,
  };
}

/**
 * Bearing of the resort's base side (degrees clockwise from north), from
 * the downhill direction of its runs and lifts over this terrain. Null
 * when there is no clear front.
 */
export function resortFrontBearing(spec: PlaneSpec & { resort: ResortData }): number | null {
  const { shape, widthInches, heightInches, rotation, resort } = spec;
  const { geoToLocal, gridW, gridH } = modelPlane(spec);
  const lines = [...resort.runs.filter((r) => !r.isArea), ...resort.lifts];
  return frontBearing({
    paths: lines.map((l) => l.coords.map(geoToLocal)),
    // Only relative heights matter here, so no base and no exaggeration.
    heightAt: heightSampler(spec.data, gridW, gridH, 0, 1),
    inside: (x, z) => pointInShape(shape, x, z, widthInches, heightInches, rotation),
  });
}

/**
 * Step boundaries for this model's stacked finish, measured over the part
 * of the terrain that survives the cut. Null when none of it does.
 */
export function terrainLayersFor(
  spec: PlaneSpec & {
    baseThicknessInches: number;
    verticalExaggeration: number;
    count: number;
    insideOutline?: (x: number, z: number) => boolean;
  },
): TerrainLayers | null {
  const { data, shape, widthInches, heightInches, rotation, insideOutline } = spec;
  const { gridW, gridH, inPerMeter } = modelPlane(spec);
  const yPerMeter = inPerMeter * spec.verticalExaggeration;
  let low = Infinity;
  let high = -Infinity;
  for (let j = 0; j < data.height; j++) {
    const z = gridH / 2 - (j * gridH) / (data.height - 1);
    for (let i = 0; i < data.width; i++) {
      const x = -gridW / 2 + (i * gridW) / (data.width - 1);
      if (!pointInShape(shape, x, z, widthInches, heightInches, rotation)) continue;
      if (insideOutline && !insideOutline(x, z)) continue;
      const y = spec.baseThicknessInches + (data.heights[j * data.width + i] - data.min) * yPerMeter;
      if (y < low) low = y;
      if (y > high) high = y;
    }
  }
  if (!Number.isFinite(low) || high <= low) return null;
  return { levels: layerLevels(low, high, spec.count), baseY: spec.baseThicknessInches };
}

/**
 * Every drawn run and lift as a polyline in the model plane, for tracing an
 * outline. Polygon runs are left out: they aren't drawn, and a backcountry
 * zone mapped as one would add a piece of model with nothing on it. So
 * are lines tagged only to another ski area: neighbors like Alta and
 * Snowbird touch, and would otherwise merge into one shape.
 */
export function resortLinesOnPlane(
  spec: PlaneSpec & { resort: ResortData; areaId?: string | null },
): Array<Array<[number, number]>> {
  const { geoToLocal } = modelPlane(spec);
  const { areaId } = spec;
  const drawn = [...spec.resort.runs.filter((r) => !r.isArea), ...spec.resort.lifts];
  return drawn
    .filter((line) => !areaId || !line.areas?.length || line.areas.includes(areaId))
    .map((line) => line.coords.map(geoToLocal));
}

export function buildRunRibbons(spec: RunMeshSpec): RibbonGroup[] {
  const {
    data,
    shape,
    widthInches,
    heightInches,
    rotation,
    baseThicknessInches,
    verticalExaggeration,
    resort,
    scheme,
    showLifts,
    minWidthMm,
    lift,
    insideOutline,
    layerLevels: levels,
  } = spec;

  const { geoToLocal, gridW, gridH, inPerMeter } = modelPlane(spec);
  const surface = heightSampler(data, gridW, gridH, baseThicknessInches, inPerMeter * verticalExaggeration);
  const sampler: HeightSampler = levels
    ? (x, z) => layerTopAt(levels, surface(x, z))
    : surface;
  const inside = (x: number, z: number) =>
    pointInShape(shape, x, z, widthInches, heightInches, rotation) &&
    (insideOutline?.(x, z) ?? true);

  const cellIn = gridW / (data.width - 1);
  const minWidthIn = minWidthMm / MM_PER_INCH;
  const widthFor = (meters: number) => Math.max(minWidthIn, meters * inPerMeter);

  const groups = new Map<string, Builder & { rgb: Rgb }>();
  const groupFor = (name: string, rgb: Rgb) => {
    let g = groups.get(name);
    if (!g) {
      g = { positions: [], indices: [], count: 0, rgb };
      groups.set(name, g);
    }
    return g;
  };

  const runWidth = widthFor(DEFAULT_RUN_WIDTH_M);
  for (const run of resort.runs) {
    // Polygon pistes would come out as a ribbon around their outline;
    // filling them is roadmap work.
    if (run.isArea) continue;
    const color = runColor(run.difficulty, scheme);
    const g = groupFor(color.name, color.rgb);
    const path = run.coords.map(geoToLocal);
    if (appendRibbon(g, path, runWidth, cellIn, sampler, inside, lift, Boolean(levels))) g.count++;
  }

  if (showLifts) {
    const liftWidth = widthFor(DEFAULT_LIFT_WIDTH_M);
    for (const l of resort.lifts) {
      const color = liftColor(l.type);
      const g = groupFor(color.name, color.rgb);
      const path = l.coords.map(geoToLocal);
      // Lifts fly over terrain, so sample straight along the line rather
      // than hugging every dip, and sit a little higher than runs.
      if (appendRibbon(g, path, liftWidth, cellIn, sampler, inside, lift * 2, Boolean(levels))) g.count++;
    }
  }

  const out: RibbonGroup[] = [];
  for (const [name, g] of groups) {
    if (g.indices.length === 0) continue;
    const positions = new Float32Array(g.positions);
    const indices = new Uint32Array(g.indices);
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals, { useRightHandedSystem: true });
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    out.push({ name, rgb: g.rgb, vertexData: vd, count: g.count });
  }
  return out;
}

type HeightSampler = (x: number, z: number) => number;

/**
 * Bilinear height lookup in model-plane inches. The grid spans the AABB of
 * the (possibly rotated) shape, north row first, matching the terrain mesh.
 */
function heightSampler(
  data: ElevationResponse,
  gridW: number,
  gridH: number,
  base: number,
  yPerMeter: number,
): HeightSampler {
  const { heights, width: gw, height: gh, min } = data;
  return (x, z) => {
    const fi = ((x + gridW / 2) / gridW) * (gw - 1);
    const fj = ((gridH / 2 - z) / gridH) * (gh - 1);
    const i0 = clamp(Math.floor(fi), 0, gw - 2);
    const j0 = clamp(Math.floor(fj), 0, gh - 2);
    const tx = clamp(fi - i0, 0, 1);
    const tz = clamp(fj - j0, 0, 1);
    const h00 = heights[j0 * gw + i0];
    const h10 = heights[j0 * gw + i0 + 1];
    const h01 = heights[(j0 + 1) * gw + i0];
    const h11 = heights[(j0 + 1) * gw + i0 + 1];
    const h =
      h00 * (1 - tx) * (1 - tz) +
      h10 * tx * (1 - tz) +
      h01 * (1 - tx) * tz +
      h11 * tx * tz;
    return base + (h - min) * yPerMeter;
  };
}

/**
 * Append one ribbon to a builder. Returns false when nothing of the path
 * fell inside the model footprint.
 */
function appendRibbon(
  g: Builder,
  path: Array<[number, number]>,
  width: number,
  step: number,
  sample: HeightSampler,
  inside: (x: number, z: number) => boolean,
  lift: number,
  flatSteps: boolean,
): boolean {
  const dense = densify(path, step);
  const half = width / 2;
  let emitted = false;

  // Split at the footprint boundary so clipped runs become separate
  // strips instead of one strip with a long bridge across the gap. The
  // whole cross-section must be inside, or the ribbon would overhang
  // the side wall (or removed cells, on circles and hexes).
  let strip: Array<[number, number]> = [];
  let stripTop = NaN;
  const flush = () => {
    if (strip.length >= 2) {
      emitStrip(g, strip, half, sample, lift);
      emitted = true;
    }
    strip = [];
  };
  for (let k = 0; k < dense.length; k++) {
    const p = dense[k];
    const [nx, nz] = sideNormal(dense, k);
    const fits =
      inside(p[0], p[1]) &&
      inside(p[0] + nx * half, p[1] + nz * half) &&
      inside(p[0] - nx * half, p[1] - nz * half);
    // On stacked terrain a ribbon only lies on one flat top at a time. A
    // cross-section straddling a step would be a spike down its wall.
    const top = sample(p[0], p[1]);
    const onOneStep =
      !flatSteps ||
      (sample(p[0] + nx * half, p[1] + nz * half) === top &&
        sample(p[0] - nx * half, p[1] - nz * half) === top);
    if (!fits || !onOneStep) {
      flush();
      continue;
    }
    if (flatSteps && top !== stripTop) flush();
    stripTop = top;
    strip.push(p);
  }
  flush();
  return emitted;
}

/**
 * Unit normal to the path at point k, averaging the segments on each
 * side so the cross-section stays perpendicular through bends.
 */
function sideNormal(pts: Array<[number, number]>, k: number): [number, number] {
  const n = pts.length;
  const [ax, az] = pts[Math.max(0, k - 1)];
  const [bx, bz] = pts[Math.min(n - 1, k + 1)];
  let dx = bx - ax;
  let dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len === 0) return [0, 1];
  dx /= len;
  dz /= len;
  return [-dz, dx];
}

function emitStrip(
  g: Builder,
  pts: Array<[number, number]>,
  half: number,
  sample: HeightSampler,
  lift: number,
): void {
  const n = pts.length;
  const start = g.positions.length / 3;

  for (let k = 0; k < n; k++) {
    const [px, pz] = pts[k];
    const [nx, nz] = sideNormal(pts, k);
    const lx = px + nx * half;
    const lz = pz + nz * half;
    const rx = px - nx * half;
    const rz = pz - nz * half;
    g.positions.push(lx, sample(lx, lz) + lift, lz);
    g.positions.push(rx, sample(rx, rz) + lift, rz);
  }

  for (let k = 0; k < n - 1; k++) {
    const l0 = start + k * 2;
    const r0 = l0 + 1;
    const l1 = l0 + 2;
    const r1 = l0 + 3;
    // CCW from above gives +Y normals; the material disables back-face
    // culling so steep faces still render when seen edge-on.
    g.indices.push(l0, l1, r0, r0, l1, r1);
  }
}

/**
 * Insert points along each segment so no step exceeds `maxStep`, and drop
 * repeated nodes (OSM has them) that would give a zero-length segment.
 */
function densify(path: Array<[number, number]>, maxStep: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (i === 0) {
      out.push(p);
      continue;
    }
    const q = out[out.length - 1];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(d / maxStep));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t]);
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
