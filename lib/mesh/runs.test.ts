import { describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { ResortData } from "@/lib/resort/types";
import type { Bbox } from "@/lib/types";

import { buildRunRibbons, type RunMeshSpec } from "./runs";

// 6" square frame centered on Jay Peak; roughly 1:33,000.
const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];

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

function spec(resort: ResortData, overrides: Partial<RunMeshSpec> = {}): RunMeshSpec {
  return {
    bbox,
    data: flatGrid(16, 500),
    shape: "rectangle",
    widthInches: 6,
    heightInches: 6,
    rotation: 0,
    baseThicknessInches: 0.25,
    verticalExaggeration: 2,
    resort,
    scheme: "na",
    showLifts: true,
    minWidthMm: 1.2,
    lift: 0.01,
    ...overrides,
  };
}

const centerRun = {
  id: 1,
  difficulty: "easy" as const,
  coords: [
    [-72.51, 44.93],
    [-72.49, 44.93],
  ] as [number, number][],
  isArea: false,
};

describe("buildRunRibbons", () => {
  it("groups by color and sits just above the terrain", () => {
    const resort: ResortData = {
      runs: [
        centerRun,
        { ...centerRun, id: 2, difficulty: "intermediate" },
        { ...centerRun, id: 3, difficulty: "expert" },
        { ...centerRun, id: 4, difficulty: "advanced" },
      ],
      lifts: [{ id: 9, type: "chair_lift", coords: centerRun.coords }],
      bbox,
      extent: bbox,
    };
    const groups = buildRunRibbons(spec(resort));
    const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
    expect(Object.keys(byName).sort()).toEqual(["black", "blue", "green", "lift"]);
    expect(byName.black.count).toBe(2);

    const positions = byName.green.vertexData.positions as Float32Array;
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0.25 + 0.01, 5);
    }
  });

  it("widens narrow runs to the minimum printable width", () => {
    const resort: ResortData = { runs: [centerRun], lifts: [], bbox, extent: bbox };
    const [green] = buildRunRibbons(spec(resort, { minWidthMm: 2.54 }));
    const positions = green.vertexData.positions as Float32Array;
    // First cross-section: left and right vertices straddle the centerline
    // by half the width (z axis, since the run heads east).
    const widthIn = Math.abs(positions[2] - positions[5]);
    expect(widthIn).toBeCloseTo(0.1, 3);
  });

  it("drops lifts when disabled and runs outside the footprint", () => {
    const outside = {
      ...centerRun,
      id: 5,
      coords: [
        [-72.6, 44.8],
        [-72.59, 44.8],
      ] as [number, number][],
    };
    const resort: ResortData = {
      runs: [outside],
      lifts: [{ id: 9, type: "gondola", coords: centerRun.coords }],
      bbox,
      extent: bbox,
    };
    expect(buildRunRibbons(spec(resort, { showLifts: false }))).toEqual([]);
    expect(buildRunRibbons(spec(resort)).map((g) => g.name)).toEqual(["lift"]);
  });

  it("clips a run that crosses a circular footprint into separate strips", () => {
    const crossing = {
      ...centerRun,
      coords: [
        [-72.53, 44.95],
        [-72.47, 44.91],
      ] as [number, number][],
    };
    const resort: ResortData = { runs: [crossing], lifts: [], bbox, extent: bbox };
    const [green] = buildRunRibbons(spec(resort, { shape: "circle" }));
    const positions = green.vertexData.positions as Float32Array;
    const r = 3;
    for (let i = 0; i < positions.length; i += 3) {
      const d = Math.hypot(positions[i], positions[i + 2]);
      expect(d).toBeLessThanOrEqual(r + 0.1);
    }
  });
});
