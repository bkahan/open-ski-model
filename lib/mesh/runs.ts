// Ski runs and lifts in the model's own plane: where each line falls on the
// print, how wide it prints, and which color it belongs to.
//
// Widths are clamped to a printable minimum. A 10 m cat track at 1:20,000
// is 0.5 mm wide, below what a nozzle can resolve, so anything narrower
// than `minWidthMm` is widened to it.

import { bboxCenter, bboxWidthMeters, metersPerDegLng } from "@/lib/bbox";
import type { ElevationResponse } from "@/lib/elevation/types";
import type { InlayGroup, InlayPath } from "@/lib/mesh/inlays";
import { LIFT_COLOR, runColor, type ColorScheme } from "@/lib/resort/colors";
import { frontBearing } from "@/lib/resort/front";
import type { ResortData } from "@/lib/resort/types";
import { pointInShape, shapeAABBHalf, type Shape } from "@/lib/shape";
import type { Bbox, LngLat } from "@/lib/types";

const METERS_PER_DEG_LAT = 111_320;
const MM_PER_INCH = 25.4;

/** Real-world widths assumed when OSM doesn't say (it rarely does). */
const DEFAULT_RUN_WIDTH_M = 30;
const DEFAULT_LIFT_WIDTH_M = 8;

/** The inputs that fix how lng/lat maps onto the model plane. */
export interface PlaneSpec {
  bbox: Bbox;
  data: ElevationResponse;
  shape: Shape;
  /** Shape pre-rotation dimensions in inches. */
  widthInches: number;
  heightInches: number;
  rotation: number;
}

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

/** Where lines cross, the higher one wins: lifts over black over blue over green. */
const COLOR_PRIORITY = ["lift", "black", "red", "orange", "blue", "green", "gray"];

/** Runs and lifts by color at their printed widths, highest priority first. */
export function resortInlayGroups(
  spec: PlaneSpec & {
    resort: ResortData;
    areaId?: string | null;
    scheme: ColorScheme;
    showLifts: boolean;
    minWidthMm: number;
  },
): InlayGroup[] {
  const { geoToLocal, inPerMeter } = modelPlane(spec);
  const { resort, areaId, scheme, showLifts, minWidthMm } = spec;
  const minWidthIn = minWidthMm / MM_PER_INCH;
  const halfWidth = (meters: number) => Math.max(minWidthIn, meters * inPerMeter) / 2;
  const belongs = (line: { areas?: string[] }) =>
    !areaId || !line.areas?.length || line.areas.includes(areaId);
  const byColor = new Map<string, InlayPath[]>();
  const add = (color: string, path: InlayPath) => {
    byColor.set(color, [...(byColor.get(color) ?? []), path]);
  };
  for (const run of resort.runs) {
    if (run.isArea || !belongs(run)) continue;
    add(runColor(run.difficulty, scheme).name, {
      points: run.coords.map(geoToLocal),
      halfWidth: halfWidth(DEFAULT_RUN_WIDTH_M),
    });
  }
  if (showLifts) {
    for (const lift of resort.lifts) {
      if (!belongs(lift)) continue;
      add(LIFT_COLOR.name, {
        points: lift.coords.map(geoToLocal),
        halfWidth: halfWidth(DEFAULT_LIFT_WIDTH_M),
      });
    }
  }
  return COLOR_PRIORITY.flatMap((key) => {
    const paths = byColor.get(key);
    return paths ? [{ key, paths }] : [];
  });
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
