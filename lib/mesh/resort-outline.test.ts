import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";

import { bboxFromCenterWH } from "@/lib/bbox";
import { frameAroundResort, OUTLINE_FRAME_PADDING } from "@/lib/resort/frame";
import type { ResortData, SkiRun } from "@/lib/resort/types";
import { shapeAABBHalf, shapeOutline } from "@/lib/shape";
import type { LngLat } from "@/lib/types";

import { gapBetween } from "./printable";
import { ESTIMATED_OUTLINE_SHARE, outlineOnMap, outlineShare, traceResortOutline, type OutlineSpec } from "./resort-outline";
import { planePointsOnMap, resortLinesOnPlane } from "./runs";
import type { Contour } from "./text";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;

beforeAll(async () => {
  m = await Module();
  m.setup();
});

const AREA = "jay";
const SIDE_IN = 6;
const GRID = 256;

/** A run with no ski-area tag at all, as many real ones are mapped. */
const untaggedRun = (coords: LngLat[]): SkiRun => ({
  id: coords.map(String).join("|"),
  difficulty: "easy",
  convention: "north_america",
  coords,
  isArea: false,
});

const run = (coords: LngLat[], areas: string[] = [AREA]): SkiRun => ({ ...untaggedRun(coords), areas });

/** Where one run falls on a spec's plane, whatever it is tagged. */
function onPlaneOf(spec: OutlineSpec, line: SkiRun): Array<[number, number]> {
  const [points] = resortLinesOnPlane({ ...spec, areaId: null, resort: resortOf([line]) });
  expect(points).toHaveLength(line.coords.length);
  return points;
}

const resortOf = (runs: SkiRun[]): ResortData => ({
  runs,
  lifts: [],
  bbox: [-73, 44, -72, 45],
  extent: null,
  convention: "north_america",
});

// A summit with runs fanning out to three bases, about 2.6 km by 1.9 km.
const summit: LngLat = [-72.515, 44.925];
const jayRuns = [
  run([summit, [-72.508, 44.932], [-72.5, 44.938]]),
  run([summit, [-72.52, 44.933], [-72.524, 44.941]]),
  run([summit, [-72.506, 44.928], [-72.492, 44.931]]),
  run([[-72.5, 44.938], [-72.51, 44.94], [-72.524, 44.941]]),
];

/** The frame the app fits to a picked resort, and the outline spec that goes with it. */
function fittedSpec(resort: ResortData, rotation: number): OutlineSpec {
  const frame = frameAroundResort(resort, AREA, rotation, OUTLINE_FRAME_PADDING);
  if (!frame) throw new Error("no lines to frame");
  const metersPerInch = frame.sideMeters / SIDE_IN;
  const [halfW, halfH] = shapeAABBHalf("rectangle", SIDE_IN, SIDE_IN, rotation);
  return {
    bbox: bboxFromCenterWH(frame.center, halfW * 2 * metersPerInch, halfH * 2 * metersPerInch),
    shape: "rectangle",
    widthInches: SIDE_IN,
    heightInches: SIDE_IN,
    rotation,
    resort,
    areaId: AREA,
    gridColumns: GRID,
  };
}

function contains(ring: Array<[number, number]>, [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

describe("traceResortOutline", () => {
  it.each([0, 30, 88, 271])("holds every line of a fitted resort without reaching the frame, turned %d degrees", (rotation) => {
    const spec = fittedSpec(resortOf(jayRuns), rotation);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;

    const lines = resortLinesOnPlane(spec);
    expect(lines).toHaveLength(jayRuns.length);
    for (const line of lines) {
      for (const point of line) expect(contains(ring, point)).toBe(true);
    }

    // The ring is clipped to the frame less one grid cell. A fitted frame
    // leaves it standing clear of that edge, so nothing is cut off flat.
    const cell = (shapeAABBHalf("rectangle", SIDE_IN, SIDE_IN, rotation)[0] * 2) / (GRID - 1);
    const edge: Contour = shapeOutline("rectangle", SIDE_IN - 2 * cell, SIDE_IN - 2 * cell, rotation);
    expect(gapBetween([ring], [edge])).toBeGreaterThan(0.05);
    for (const corner of edge) expect(contains(ring, corner)).toBe(false);
  });

  it("is cut flat by a frame smaller than the resort, which is why the frame is not the user's to set", () => {
    const fitted = fittedSpec(resortOf(jayRuns), 0);
    const [west, south, east, north] = fitted.bbox;
    const midLng = (west + east) / 2;
    const midLat = (south + north) / 2;
    const tight: OutlineSpec = {
      ...fitted,
      bbox: [midLng - (east - west) / 4, midLat - (north - south) / 4, midLng + (east - west) / 4, midLat + (north - south) / 4],
    };
    const ring = traceResortOutline(m, tight);
    expect(ring).not.toBeNull();
    if (!ring) return;
    const cell = SIDE_IN / (GRID - 1);
    const edge: Contour = shapeOutline("rectangle", SIDE_IN - 2 * cell, SIDE_IN - 2 * cell, 0);
    expect(gapBetween([ring], [edge])).toBeLessThan(1e-6);
  });

  it("leaves out lines tagged only to another ski area and keeps untagged ones", () => {
    const neighbor = run([[-72.495, 44.94], [-72.493, 44.9405]], ["burke"]);
    const glade = untaggedRun([[-72.509, 44.936], [-72.507, 44.9375]]);
    const spec = fittedSpec(resortOf([...jayRuns, neighbor, glade]), 0);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    for (const point of onPlaneOf(spec, glade)) expect(contains(ring, point)).toBe(true);
    expect(onPlaneOf(spec, neighbor).some((point) => contains(ring, point))).toBe(false);
  });

  it("takes in an untagged run that leaves the resort, and still clears the frame", () => {
    // Sidecountry mapped without a ski-area tag: it starts on the resort
    // and runs well out past the tagged lines.
    const sidecountry = untaggedRun([[-72.493, 44.931], [-72.48, 44.928], [-72.468, 44.926]]);
    const spec = fittedSpec(resortOf([...jayRuns, sidecountry]), 0);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    for (const point of onPlaneOf(spec, sidecountry)) expect(contains(ring, point)).toBe(true);
    const cell = SIDE_IN / (GRID - 1);
    const edge: Contour = shapeOutline("rectangle", SIDE_IN - 2 * cell, SIDE_IN - 2 * cell, 0);
    expect(gapBetween([ring], [edge])).toBeGreaterThan(0.05);
  });

  it("does not follow a chain of untagged runs out to the frame's edge", () => {
    // The first leaves the resort; the second starts where the first ends,
    // well outside it. The frame is fitted without the second, so tracing
    // it too would run the outline into the frame's edge and cut it flat.
    const sidecountry = untaggedRun([[-72.493, 44.931], [-72.48, 44.928], [-72.468, 44.926]]);
    const beyond = untaggedRun([[-72.468, 44.926], [-72.45, 44.925], [-72.43, 44.925]]);
    const spec = fittedSpec(resortOf([...jayRuns, sidecountry, beyond]), 0);
    expect(spec.bbox).toEqual(fittedSpec(resortOf([...jayRuns, sidecountry]), 0).bbox);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    const cell = SIDE_IN / (GRID - 1);
    const edge: Contour = shapeOutline("rectangle", SIDE_IN - 2 * cell, SIDE_IN - 2 * cell, 0);
    expect(gapBetween([ring], [edge])).toBeGreaterThan(0.05);
  });

  it("leaves out an untagged run that never comes near the resort", () => {
    const elsewhere = untaggedRun([[-72.535, 44.912], [-72.533, 44.9125]]);
    const spec = fittedSpec(resortOf([...jayRuns, elsewhere]), 0);
    // It does not move the frame either.
    expect(spec.bbox).toEqual(fittedSpec(resortOf(jayRuns), 0).bbox);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    expect(onPlaneOf(spec, elsewhere).some((point) => contains(ring, point))).toBe(false);
  });

  it("has nothing to trace without lines", () => {
    const spec = { ...fittedSpec(resortOf(jayRuns), 0), resort: resortOf([]) };
    expect(traceResortOutline(m, spec)).toBeNull();
  });
});

describe("a frame fitted at the coarsest grid", () => {
  it("still clears the outline, though the cell held back from the edge is four times wider", () => {
    const spec = { ...fittedSpec(resortOf(jayRuns), 30), gridColumns: 64 };
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    const cell = (shapeAABBHalf("rectangle", SIDE_IN, SIDE_IN, 30)[0] * 2) / 63;
    const edge: Contour = shapeOutline("rectangle", SIDE_IN - 2 * cell, SIDE_IN - 2 * cell, 30);
    expect(gapBetween([ring], [edge])).toBeGreaterThan(0.01);
  });
});

describe("outlineOnMap", () => {
  it("puts the ring back on the ground, around the lines it was traced from", () => {
    const spec = fittedSpec(resortOf(jayRuns), 30);
    const ring = traceResortOutline(m, spec);
    expect(ring).not.toBeNull();
    if (!ring) return;
    const onMap = outlineOnMap(spec, ring);
    expect(onMap).toHaveLength(ring.length);
    for (const line of jayRuns) {
      for (const point of line.coords) expect(contains(onMap, point)).toBe(true);
    }
    const [west, south, east, north] = spec.bbox;
    for (const [lng, lat] of onMap) {
      expect(lng).toBeGreaterThan(west);
      expect(lng).toBeLessThan(east);
      expect(lat).toBeGreaterThan(south);
      expect(lat).toBeLessThan(north);
    }
  });

  it("undoes the mapping onto the plane", () => {
    const spec = fittedSpec(resortOf(jayRuns), 88);
    const back = planePointsOnMap(spec, onPlaneOf(spec, jayRuns[0]));
    expect(back).toHaveLength(jayRuns[0].coords.length);
    jayRuns[0].coords.forEach(([lng, lat], i) => {
      expect(back[i][0]).toBeCloseTo(lng, 9);
      expect(back[i][1]).toBeCloseTo(lat, 9);
    });
  });
});

describe("outlineShare", () => {
  const square: Contour = [
    [-2, -1],
    [2, -1],
    [2, 1],
    [-2, 1],
  ];
  const frame = (rotation: number) => ({ ...fittedSpec(resortOf(jayRuns), rotation), widthInches: 8, heightInches: 8 });

  it("is the ring's longest side over the frame's", () => {
    expect(outlineShare(frame(0), square)).toBeCloseTo(4 / 8, 9);
  });

  it("measures square to a turned frame, not north-up", () => {
    // A 4 by 2 box lying along a frame turned 30 degrees is still 4 long.
    const a = (30 * Math.PI) / 180;
    const [origin, alongWidth] = shapeOutline("rectangle", 1, 1, 30);
    const ux = alongWidth[0] - origin[0];
    const uz = alongWidth[1] - origin[1];
    expect(Math.hypot(ux, uz)).toBeCloseTo(1, 9);
    expect(Math.abs(Math.cos(a) * ux) + Math.abs(Math.sin(a) * uz)).toBeGreaterThan(0.99);
    const turned = square.map(([x, z]): [number, number] => [x * ux - z * uz, x * uz + z * ux]);
    expect(outlineShare(frame(30), turned)).toBeCloseTo(4 / 8, 9);
    // North-up, the same ring's corners reach further than its length.
    expect(outlineShare(frame(0), turned)).toBeCloseTo((4 * Math.cos(a) + 2 * Math.sin(a)) / 8, 9);
  });

  it("has no share to give for a ring with no extent", () => {
    expect(outlineShare(frame(0), [])).toBeNull();
    expect(outlineShare(frame(0), [[1, 1]])).toBeNull();
  });

  it("holds at any print size, since the outline is built in proportion to its frame", () => {
    const at = (inches: number) => {
      const spec = { ...fittedSpec(resortOf(jayRuns), 30), widthInches: inches, heightInches: inches };
      const ring = traceResortOutline(m, spec);
      expect(ring).not.toBeNull();
      return (ring && outlineShare(spec, ring)) ?? 0;
    };
    const small = at(4);
    expect(at(6)).toBeCloseTo(small, 2);
    expect(at(18)).toBeCloseTo(small, 2);
    // A fitted resort's outline fills most of its frame; the estimate used
    // before the first trace is in the right place.
    expect(Math.abs(small - ESTIMATED_OUTLINE_SHARE)).toBeLessThan(0.06);
  });
});
