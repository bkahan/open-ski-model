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
/** Two lines whose centers come this close meet on the ground: about one run's width. */
const CONNECTED_GAP_METERS = 30;
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

type Line = SkiRun | SkiLift;
/** Meters east and north of a shared origin. */
type GroundPoint = [number, number];

/** How far past its own tags a ski area's lines are followed. */
export interface ResortLineOptions {
  /**
   * Also take the untagged lines that start past the resort's reach but
   * join its lines, however far the chain runs: Sugarloaf's Burnt
   * Mountain glades. The data doesn't say whether the resort counts such
   * a run as its own, and the same rule follows a backcountry trail that
   * happens to end on a run (the Teardrop at Stowe), so it is a choice.
   */
  followConnected: boolean;
}

interface GroundLine {
  line: Line;
  /** The line's segments; a single point is one of no length. */
  segments: Array<[GroundPoint, GroundPoint]>;
  /** [west, south, east, north] of the line. */
  bounds: [number, number, number, number];
}

function onGround(line: Line, origin: LngLat): GroundLine {
  const mPerDegLng = metersPerDegLng(origin[1]);
  const points = line.coords.map(([lng, lat]): GroundPoint => [
    (lng - origin[0]) * mPerDegLng,
    (lat - origin[1]) * METERS_PER_DEG_LAT,
  ]);
  const bounds: GroundLine["bounds"] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  const segments =
    points.length === 1
      ? [[points[0], points[0]] satisfies [GroundPoint, GroundPoint]]
      : points.slice(1).map((point, i): [GroundPoint, GroundPoint] => [points[i], point]);
  return { line, segments, bounds };
}

function pointToSegment(p: GroundPoint, a: GroundPoint, b: GroundPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Which side of the line through `a` and `b` the point is on, by sign. */
function side(a: GroundPoint, b: GroundPoint, p: GroundPoint): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function segmentGap([a, b]: [GroundPoint, GroundPoint], [c, d]: [GroundPoint, GroundPoint]): number {
  // Two long segments can cross with every end far from the other: a lift over a run.
  const cross = side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
  if (cross) return 0;
  return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
}

function meet(a: GroundLine, b: GroundLine, gap: number): boolean {
  const apart =
    a.bounds[0] - b.bounds[2] > gap ||
    b.bounds[0] - a.bounds[2] > gap ||
    a.bounds[1] - b.bounds[3] > gap ||
    b.bounds[1] - a.bounds[3] > gap;
  if (apart) return false;
  return a.segments.some((ours) => b.segments.some((theirs) => segmentGap(ours, theirs) <= gap));
}

/**
 * The `candidates` that meet one of `lines`, or meet one that does, and
 * so on outward: a run off the back of the mountain, then the runs off
 * that one. Each round only looks at the lines the last round found,
 * since everything waiting has already been held against the rest.
 */
function linesJoining(lines: Line[], candidates: Line[]): Line[] {
  const origin = lines[0].coords[0];
  let reached = lines.map((line) => onGround(line, origin));
  let waiting = candidates.map((line) => onGround(line, origin));
  const joined: Line[] = [];
  while (reached.length > 0 && waiting.length > 0) {
    const found: GroundLine[] = [];
    const still: GroundLine[] = [];
    for (const candidate of waiting) {
      if (reached.some((line) => meet(candidate, line, CONNECTED_GAP_METERS))) found.push(candidate);
      else still.push(candidate);
    }
    joined.push(...found.map((ground) => ground.line));
    reached = found;
    waiting = still;
  }
  return joined;
}

/**
 * The runs and lifts that make up ski area `areaId`: the lines tagged
 * with it, and the untagged lines that reach them. Many real runs carry
 * no ski-area tag at all (Jay's glades don't). Lines tagged only to
 * another area are a neighbor's, and polygons are skipped: they aren't
 * drawn, and OSM often maps a whole backcountry zone as one. Empty when
 * nothing is tagged.
 */
export function resortLines(resort: ResortData, areaId: string, options: ResortLineOptions): Line[] {
  const drawn = [...resort.runs.filter((r) => !r.isArea), ...resort.lifts].filter(
    (line) => line.coords.length > 0,
  );
  const tagged = drawn.filter((line) => line.areas?.includes(areaId));
  if (tagged.length === 0) return [];
  const reach = expandedBounds(tagged.flatMap((line) => line.coords), UNTAGGED_REACH);
  const near: Line[] = [];
  const further: Line[] = [];
  for (const line of drawn) {
    if (line.areas?.length) continue;
    if (line.coords.some((p) => isWithin(p, reach))) near.push(line);
    else further.push(line);
  }
  const lines = [...tagged, ...near];
  return options.followConnected ? [...lines, ...linesJoining(lines, further)] : lines;
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
  options: ResortLineOptions,
): ResortFrame | null {
  const points = resortLines(resort, areaId, options).flatMap((line) => line.coords);
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
