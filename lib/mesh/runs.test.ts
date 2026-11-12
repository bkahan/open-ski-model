import { describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { ResortData } from "@/lib/resort/types";
import type { Bbox } from "@/lib/types";

import { resortFrontBearing, resortInlayGroups, resortLinesOnPlane, type PlaneSpec } from "./runs";

// 6" square frame centered on Jay Peak; roughly 1:33,000.
const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];
const INCHES_PER_METER = 6 / 4723;

function flatGrid(size: number, elevation: number): ElevationResponse {
  return {
    heights: new Array(size * size).fill(elevation),
    width: size,
    height: size,
    min: elevation,
    max: elevation + 1,
    source: "terrarium",
    zoom: 12,
  };
}

const plane: PlaneSpec = {
  bbox,
  data: flatGrid(16, 500),
  shape: "rectangle",
  widthInches: 6,
  heightInches: 6,
  rotation: 0,
};

const centerRun = {
  id: "1",
  difficulty: "easy" as const,
  convention: "north_america" as const,
  coords: [
    [-72.51, 44.93],
    [-72.49, 44.93],
  ] as [number, number][],
  isArea: false,
};

function resortOf(runs: ResortData["runs"], lifts: ResortData["lifts"] = []): ResortData {
  return { runs, lifts, bbox, extent: bbox, convention: "north_america" };
}

const style = { scheme: "na" as const, showLifts: true, minWidthMm: 1.2 };

describe("resortInlayGroups", () => {
  const chair = { id: "9", type: "chair_lift" as const, coords: centerRun.coords };

  it("groups by color, highest priority first", () => {
    const resort = resortOf(
      [
        centerRun,
        { ...centerRun, id: "2", difficulty: "intermediate" },
        { ...centerRun, id: "3", difficulty: "expert" },
        { ...centerRun, id: "4", difficulty: "advanced" },
      ],
      [chair],
    );
    const groups = resortInlayGroups({ ...plane, resort, ...style });
    expect(groups.map((g) => g.key)).toEqual(["lift", "black", "blue", "green"]);
    expect(groups[1].paths).toHaveLength(2);
  });

  it("puts each line where its coordinates fall on the print", () => {
    const [green] = resortInlayGroups({ ...plane, resort: resortOf([centerRun]), ...style });
    const [[westX, westZ], [eastX, eastZ]] = green.paths[0].points;
    // The run crosses the frame's center from west to east, 0.02 degrees long.
    expect(westX).toBeCloseTo(-eastX, 6);
    expect(westZ).toBeCloseTo(0, 6);
    expect(eastZ).toBeCloseTo(0, 6);
    expect(eastX - westX).toBeCloseTo(2, 1);
  });

  it("prints a run at its real width when that is wide enough", () => {
    const [green] = resortInlayGroups({ ...plane, resort: resortOf([centerRun]), ...style, minWidthMm: 0.4 });
    expect(green.paths[0].halfWidth).toBeCloseTo((30 * INCHES_PER_METER) / 2, 3);
  });

  it("widens anything narrower than the printable minimum", () => {
    const groups = resortInlayGroups({ ...plane, resort: resortOf([centerRun], [chair]), ...style, minWidthMm: 2.54 });
    for (const group of groups) expect(group.paths[0].halfWidth).toBeCloseTo(0.05, 6);
  });

  it("leaves lifts out when they are switched off", () => {
    const resort = resortOf([centerRun], [chair]);
    expect(resortInlayGroups({ ...plane, resort, ...style, showLifts: false }).map((g) => g.key)).toEqual(["green"]);
  });

  it("leaves out polygon runs and lines tagged only to another ski area", () => {
    const resort = resortOf([
      { ...centerRun, areas: ["jay"] },
      { ...centerRun, id: "2", difficulty: "expert", areas: ["burke"] },
      { ...centerRun, id: "3", difficulty: "intermediate", isArea: true },
    ]);
    expect(resortInlayGroups({ ...plane, resort, areaId: "jay", ...style }).map((g) => g.key)).toEqual(["green"]);
    expect(resortInlayGroups({ ...plane, resort, ...style }).map((g) => g.key)).toEqual(["black", "green"]);
  });
});

describe("resortLinesOnPlane", () => {
  it("leaves out polygon runs, which aren't drawn", () => {
    const lines = resortLinesOnPlane({
      ...plane,
      resort: resortOf(
        [centerRun, { ...centerRun, id: "zone", isArea: true }],
        [{ id: "9", type: "chair_lift", coords: centerRun.coords }],
      ),
      followConnected: false,
    });
    expect(lines).toHaveLength(2);
  });

  it("leaves out lines tagged only to another ski area", () => {
    const resort: ResortData = {
      runs: [
        { ...centerRun, areas: ["jay"] },
        { ...centerRun, id: "2", areas: ["burke"] },
        { ...centerRun, id: "3", areas: ["burke", "jay"] },
        { ...centerRun, id: "4", areas: [] },
      ],
      lifts: [],
      bbox,
      extent: bbox,
      convention: "north_america",
    };
    expect(resortLinesOnPlane({ ...plane, resort, areaId: "jay", followConnected: false })).toHaveLength(3);
    expect(resortLinesOnPlane({ ...plane, resort, followConnected: false })).toHaveLength(4);
  });
});

describe("resortFrontBearing", () => {
  // Terrain that falls to the north-east: row 0 is the north edge, so
  // height drops with i and with decreasing j.
  function tilted(size: number): ElevationResponse {
    const heights: number[] = [];
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) heights.push(1000 - 10 * i - 10 * (size - 1 - j));
    }
    return { heights, width: size, height: size, min: 0, max: 1000, source: "terrarium", zoom: 12 };
  }
  const tiltedPlane: PlaneSpec = { ...plane, data: tilted(16) };

  it("maps lng/lat onto the plane the right way round", () => {
    // A run drawn uphill (east to west) still counts as descending east;
    // a lift from the SW corner to the NE corner descends north-east.
    const resort: ResortData = {
      runs: [{ ...centerRun, coords: [[-72.49, 44.93], [-72.51, 44.93]] }],
      lifts: [{ id: "9", type: "chair_lift", coords: [[-72.52, 44.92], [-72.48, 44.94]] }],
      bbox,
      extent: bbox,
      convention: "north_america",
    };
    const bearing = resortFrontBearing({ ...tiltedPlane, resort })!;
    expect(bearing).toBeGreaterThan(45);
    expect(bearing).toBeLessThan(90);
  });

  it("ignores area runs and gives null without any lines", () => {
    const resort: ResortData = {
      runs: [{ ...centerRun, isArea: true }],
      lifts: [],
      bbox,
      extent: bbox,
      convention: "north_america",
    };
    expect(resortFrontBearing({ ...tiltedPlane, resort })).toBeNull();
  });
});
