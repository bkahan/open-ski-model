import { describe, expect, it } from "vitest";

import { metersPerDegLng } from "@/lib/bbox";
import type { LngLat } from "@/lib/types";

import { frameAroundResort, resortLines } from "./frame";
import type { ResortData, SkiRun } from "./types";

const run = (coords: LngLat[], overrides: Partial<SkiRun> = {}): SkiRun => ({
  id: String(coords[0]),
  difficulty: "easy",
  convention: "north_america",
  coords,
  isArea: false,
  areas: ["jay"],
  ...overrides,
});

const resortOf = (runs: SkiRun[]): ResortData => ({
  runs,
  lifts: [],
  bbox: [-73, 44, -72, 45],
  extent: null,
  convention: "north_america",
});

/** The ski area's lines as tagged, and with connected untagged runs followed. */
const OWN = { followConnected: false };
const FOLLOWED = { followConnected: true };

const a: LngLat = [-72.52, 44.92];
const b: LngLat = [-72.5, 44.94];

describe("frameAroundResort", () => {
  it("centers on the lines, padded, with no rotation", () => {
    const frame = frameAroundResort(resortOf([run([a, b])]), "jay", 0, 1.1, OWN)!;
    expect(frame.center[0]).toBeCloseTo(-72.51, 5);
    expect(frame.center[1]).toBeCloseTo(44.93, 5);
    const tallest = 0.02 * 111_320;
    const widest = 0.02 * metersPerDegLng(44.92);
    expect(frame.sideMeters).toBeCloseTo(Math.max(tallest, widest) * 1.1, 0);
  });

  it("measures along the turned axes", () => {
    // Points on a line running exactly along a frame turned to match it.
    const mLng = metersPerDegLng(44.92);
    const end: LngLat = [-72.52 + 1000 / mLng, 44.92 + 1000 / 111_320];
    const frame = frameAroundResort(resortOf([run([a, end])]), "jay", 45, 1, OWN)!;
    expect(frame.sideMeters).toBeCloseTo(1000 * Math.SQRT2, 0);
    expect(frame.center[0]).toBeCloseTo((a[0] + end[0]) / 2, 5);
    expect(frame.center[1]).toBeCloseTo((a[1] + end[1]) / 2, 5);
  });

  it("ignores polygons and other resorts' lines", () => {
    const far: LngLat = [-72.8, 44.6];
    const frame = frameAroundResort(
      resortOf([
        run([a, b]),
        run([a, far], { isArea: true }),
        run([b, far], { areas: ["burke"] }),
        run([far, [-72.81, 44.61]], { areas: [] }),
      ]),
      "jay",
      0,
      1,
      OWN,
    )!;
    expect(frame.center[0]).toBeCloseTo(-72.51, 5);
  });

  it("includes untagged runs that reach the resort, whole", () => {
    const beyond: LngLat = [-72.5, 44.9];
    const frame = frameAroundResort(resortOf([run([a, b]), run([a, beyond], { areas: [] })]), "jay", 0, 1, OWN)!;
    expect(frame.center[1]).toBeCloseTo((44.9 + 44.94) / 2, 5);
  });

  it("returns null when nothing is tagged", () => {
    expect(frameAroundResort(resortOf([run([a, b], { areas: ["burke"] })]), "jay", 0, 1, OWN)).toBeNull();
  });
});

describe("resortLines", () => {
  const far: LngLat = [-72.8, 44.6];

  it("is the tagged lines and the untagged ones that reach them, lifts included", () => {
    const tagged = run([a, b]);
    const reaching = run([a, far], { areas: [] });
    const lift = { id: "lift", type: "chair_lift" as const, coords: [a, b], areas: ["jay"] };
    const resort = {
      ...resortOf([
        tagged,
        reaching,
        run([a, far], { isArea: true }),
        run([b, far], { areas: ["burke"] }),
        run([far, [-72.81, 44.61]], { areas: [] }),
      ]),
      lifts: [lift],
    };
    expect(resortLines(resort, "jay", OWN)).toEqual([tagged, lift, reaching]);
  });

  it("is empty when nothing carries the tag, untagged lines or not", () => {
    expect(resortLines(resortOf([run([a, b], { areas: [] }), run([a, b], { areas: ["burke"] })]), "jay", OWN)).toEqual([]);
  });
});

describe("resortLines, following connected runs", () => {
  const untagged = (id: string, coords: LngLat[]): SkiRun => run(coords, { id, areas: [] });
  // Three kilometers west of the tagged run, well outside its reach.
  const out: LngLat = [-72.56, 44.92];
  const further: LngLat = [-72.58, 44.91];
  const furthest: LngLat = [-72.6, 44.9];
  const tagged = run([a, b]);
  const traverse = untagged("traverse", [a, out]);
  const glade = untagged("glade", [out, further]);
  const lowerGlade = untagged("lower glade", [further, furthest]);

  it("leaves them out unless asked", () => {
    const resort = resortOf([tagged, traverse, glade, lowerGlade]);
    expect(resortLines(resort, "jay", OWN)).toEqual([tagged, traverse]);
  });

  it("follows a chain of untagged runs outward from the resort", () => {
    // Listed furthest first: the chain is found whatever order the data is in.
    const resort = resortOf([lowerGlade, glade, tagged, traverse]);
    expect(resortLines(resort, "jay", FOLLOWED)).toEqual([tagged, traverse, glade, lowerGlade]);
  });

  it("takes a run that ends on the middle of another, not only at its ends", () => {
    const midway: LngLat = [-72.54, 44.92];
    const spur = untagged("spur", [[-72.54, 44.9], midway]);
    expect(resortLines(resortOf([tagged, traverse, spur]), "jay", FOLLOWED)).toEqual([tagged, traverse, spur]);
  });

  it("takes lines that cross with every end far from the other, as a lift over a run does", () => {
    // Both are single spans a kilometer or more long, crossing near their middles.
    const crossed = untagged("crossed", [out, [-72.6, 44.92]]);
    const lift = { id: "lift", type: "chair_lift" as const, coords: [[-72.58, 44.91], [-72.58, 44.93]] satisfies LngLat[] };
    const resort = { ...resortOf([tagged, traverse, crossed]), lifts: [lift] };
    expect(resortLines(resort, "jay", FOLLOWED)).toEqual([tagged, traverse, crossed, lift]);
  });

  it("still skips polygons, and lines with no points", () => {
    const zone = run([out, further, furthest], { id: "zone", areas: [], isArea: true });
    const empty = untagged("empty", []);
    expect(resortLines(resortOf([tagged, traverse, zone, empty]), "jay", FOLLOWED)).toEqual([tagged, traverse]);
    expect(resortLines(resortOf([tagged, empty]), "jay", OWN)).toEqual([tagged]);
  });

  it("counts lines within a run's width as meeting, and no further", () => {
    const metersNorth = (meters: number): LngLat => [out[0], out[1] + meters / 111_320];
    const close = untagged("close", [metersNorth(20), [-72.56, 44.95]]);
    const apart = untagged("apart", [metersNorth(60), [-72.57, 44.95]]);
    expect(resortLines(resortOf([tagged, traverse, close]), "jay", FOLLOWED)).toContain(close);
    expect(resortLines(resortOf([tagged, traverse, apart]), "jay", FOLLOWED)).not.toContain(apart);
  });

  it("never takes a neighbor's lines, or reaches through them", () => {
    const neighbors = run([out, further], { id: "neighbors", areas: ["burke"] });
    const beyondNeighbor = untagged("beyond", [further, furthest]);
    const stray = untagged("stray", [[-72.9, 44.5], [-72.91, 44.51]]);
    const resort = resortOf([tagged, traverse, neighbors, beyondNeighbor, stray]);
    expect(resortLines(resort, "jay", FOLLOWED)).toEqual([tagged, traverse]);
  });

  it("widens the frame to hold what it follows", () => {
    const resort = resortOf([tagged, traverse, glade, lowerGlade]);
    const plain = frameAroundResort(resort, "jay", 0, 1, OWN)!;
    const followed = frameAroundResort(resort, "jay", 0, 1, FOLLOWED)!;
    expect(followed.sideMeters).toBeGreaterThan(plain.sideMeters * 1.3);
    expect(followed.center[0]).toBeCloseTo((-72.6 + -72.5) / 2, 5);
  });
});
