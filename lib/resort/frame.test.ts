import { describe, expect, it } from "vitest";

import { metersPerDegLng } from "@/lib/bbox";
import type { LngLat } from "@/lib/types";

import { frameAroundResort } from "./frame";
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

const a: LngLat = [-72.52, 44.92];
const b: LngLat = [-72.5, 44.94];

describe("frameAroundResort", () => {
  it("centers on the lines, padded, with no rotation", () => {
    const frame = frameAroundResort(resortOf([run([a, b])]), "jay", 0, 1.1)!;
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
    const frame = frameAroundResort(resortOf([run([a, end])]), "jay", 45, 1)!;
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
    )!;
    expect(frame.center[0]).toBeCloseTo(-72.51, 5);
  });

  it("includes untagged runs that reach the resort, whole", () => {
    const beyond: LngLat = [-72.5, 44.9];
    const frame = frameAroundResort(resortOf([run([a, b]), run([a, beyond], { areas: [] })]), "jay", 0, 1)!;
    expect(frame.center[1]).toBeCloseTo((44.9 + 44.94) / 2, 5);
  });

  it("returns null when nothing is tagged", () => {
    expect(frameAroundResort(resortOf([run([a, b], { areas: ["burke"] })]), "jay", 0, 1)).toBeNull();
  });
});
