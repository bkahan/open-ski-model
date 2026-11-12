import { describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

import { buildWatertight, lowestKeptElevation } from "./watertight";

const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];

/** A slope that rises 100 m per column, west to east. */
function ramp(size: number): ElevationResponse {
  const heights: number[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights.push(500 + 100 * i);
  }
  return { heights, width: size, height: size, min: 500, max: 500 + 100 * (size - 1), source: "usgs", zoom: 0 };
}

const spec = { bbox, widthInches: 4, heightInches: 4, baseThicknessInches: 0.25, verticalExaggeration: 1 };

describe("floor elevation", () => {
  it("defaults to the grid's lowest point", () => {
    const { topYFn } = buildWatertight({ ...spec, data: ramp(5) });
    expect(topYFn(0)).toBeCloseTo(0.25, 6);
    expect(topYFn(4)).toBeGreaterThan(0.25);
  });

  it("puts the floor at the base and holds lower ground level with it", () => {
    const data = ramp(5);
    const plain = buildWatertight({ ...spec, data });
    const raised = buildWatertight({ ...spec, data, floorElevation: 700 });
    expect(raised.topYFn(0)).toBeCloseTo(0.25, 6);
    expect(raised.topYFn(1)).toBeCloseTo(0.25, 6);
    expect(raised.topYFn(2)).toBeCloseTo(0.25, 6);
    // Above the floor the slope is unchanged, only lowered.
    expect(raised.topYFn(4) - raised.topYFn(3)).toBeCloseTo(plain.topYFn(4) - plain.topYFn(3), 6);
    expect(raised.topYFn(4)).toBeLessThan(plain.topYFn(4));
  });
});

describe("lowestKeptElevation", () => {
  const data = ramp(5);
  // Columns sit at x = -2, -1, 0, 1, 2.

  it("is the grid's lowest point when everything is kept", () => {
    expect(lowestKeptElevation(data, 4, 4, () => true)).toBe(500);
  });

  it("counts every corner of a cell the cut passes through", () => {
    // Only the two east columns are inside, so the cut runs through the
    // cells between x = 0 and x = 1 and can expose ground down to x = 0.
    expect(lowestKeptElevation(data, 4, 4, (x) => x > 0.5)).toBe(700);
  });

  it("falls back to the grid's lowest point when nothing is kept", () => {
    expect(lowestKeptElevation(data, 4, 4, () => false)).toBe(500);
  });
});
