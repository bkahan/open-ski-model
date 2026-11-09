import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

import { layerLevels, layerTopAt, stackTerrain } from "./layers";
import { manifoldFromMesh, withSolids } from "./manifold";
import { buildWatertight } from "./watertight";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;

beforeAll(async () => {
  m = await Module();
  m.setup();
});

const PRINT_LAYER = 0.2 / 25.4;

describe("layerLevels", () => {
  it("spans the surface with one boundary more than layers", () => {
    const levels = layerLevels(0.25, 1.5, 8);
    expect(levels).toHaveLength(9);
    expect(levels[0]).toBeCloseTo(0.25);
    expect(levels[8]).toBeCloseTo(1.5, 1);
  });

  it("makes every step a whole number of print layers", () => {
    const levels = layerLevels(0.25, 1.5, 7);
    const printLayers = (levels[1] - levels[0]) / PRINT_LAYER;
    expect(printLayers).toBeCloseTo(Math.round(printLayers), 6);
  });

  it("never rounds a step down to nothing", () => {
    const levels = layerLevels(0.25, 0.2501, 4);
    expect(levels[1] - levels[0]).toBeCloseTo(PRINT_LAYER, 6);
  });
});

describe("layerTopAt", () => {
  const levels = [1, 2, 3, 4];

  it("lifts a point to the top of its step", () => {
    expect(layerTopAt(levels, 1.5)).toBe(2);
    expect(layerTopAt(levels, 2)).toBe(3);
  });

  it("keeps anything past the ends on the model", () => {
    expect(layerTopAt(levels, 0.5)).toBe(2);
    expect(layerTopAt(levels, 9)).toBe(4);
  });
});

describe("stackTerrain", () => {
  const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];
  const size = 80;
  const heights: number[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      const z = (j / (size - 1)) * 2 - 1;
      heights.push(600 + 500 * Math.exp(-(x * x + z * z) * 3));
    }
  }
  const data: ElevationResponse = {
    heights,
    width: size,
    height: size,
    min: Math.min(...heights),
    max: Math.max(...heights),
    source: "usgs",
    zoom: 0,
  };
  const baseY = 0.25;

  function hill() {
    const { vertexData } = buildWatertight({
      widthInches: 6,
      heightInches: 6,
      bbox,
      data,
      baseThicknessInches: baseY,
      verticalExaggeration: 2,
    });
    return manifoldFromMesh(m, { positions: vertexData.positions!, indices: vertexData.indices! });
  }

  it("builds one valid solid with flat steps up to the top level", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const levels = layerLevels(baseY, top, 6);
    const stacked = stackTerrain(m, terrain, { levels, baseY });
    const parts = stacked.decompose();
    withSolids([terrain, stacked, ...parts], () => {
      expect(stacked.status()).toBe("NoError");
      expect(parts).toHaveLength(1);
      expect(stacked.boundingBox().max[1]).toBeCloseTo(levels[6], 6);
      expect(stacked.boundingBox().min[0]).toBeCloseTo(terrain.boundingBox().min[0], 3);

      const { vertProperties: p, numProp } = stacked.getMesh();
      for (let i = 1; i < p.length; i += numProp) {
        const onALevel = p[i] < 1e-5 || levels.some((l) => Math.abs(l - p[i]) < 1e-5);
        expect(onALevel).toBe(true);
      }
    });
  });

  it("narrows going up, with no step overhanging the one below", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const levels = layerLevels(baseY, top, 6);
    const stacked = stackTerrain(m, terrain, { levels, baseY });
    const upright = stacked.rotate([90, 0, 0]);
    withSolids([terrain, stacked, upright], () => {
      let previous = Infinity;
      for (let k = 0; k < 6; k++) {
        const section = upright.slice((levels[k] + levels[k + 1]) / 2);
        const area = section.area();
        section.delete();
        expect(area).toBeLessThanOrEqual(previous + 1e-6);
        previous = area;
      }
    });
  });

  it("stays close to the smooth terrain's volume", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const stacked = stackTerrain(m, terrain, { levels: layerLevels(baseY, top, 16), baseY });
    withSolids([terrain, stacked], () => {
      expect(stacked.volume() / terrain.volume()).toBeCloseTo(1, 0);
    });
  });
});
