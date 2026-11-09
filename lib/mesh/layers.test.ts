import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

import { grooveDepthFor, layerLevels, layerTopAt, stackTerrain } from "./layers";
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

describe("grooveDepthFor", () => {
  it("caps at 1 mm on tall steps and stays on a print layer", () => {
    expect(grooveDepthFor(layerLevels(0, 2, 4))).toBeCloseTo(1 / 25.4, 6);
  });

  it("never takes more than half a short step", () => {
    const levels = layerLevels(0, 0.2, 8);
    expect(grooveDepthFor(levels)).toBeLessThanOrEqual((levels[1] - levels[0]) / 2 + 1e-6);
  });

  it("is at least one print layer", () => {
    expect(grooveDepthFor(layerLevels(0, 0.001, 4))).toBeCloseTo(PRINT_LAYER, 6);
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
    const stacked = stackTerrain(m, terrain, { levels, baseY }).terrain;
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
    const stacked = stackTerrain(m, terrain, { levels, baseY }).terrain;
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

  it("cuts grooves into the tops without opening the steps above", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const levels = layerLevels(baseY, top, 6);
    const depth = grooveDepthFor(levels);
    const halfWidth = 0.05;
    const grooves = [
      {
        key: "blue",
        paths: [
          {
            halfWidth,
            points: Array.from({ length: 121 }, (_, i): [number, number] => [-3 + i * 0.05, 0.02]),
          },
        ],
      },
    ];
    const plain = stackTerrain(m, terrain, { levels, baseY }).terrain;
    const cut = stackTerrain(m, terrain, { levels, baseY, grooves }).terrain;
    const parts = cut.decompose();
    withSolids([terrain, plain, cut, ...parts], () => {
      expect(cut.status()).toBe("NoError");
      expect(parts).toHaveLength(1);
      const removed = plain.volume() - cut.volume();
      // One strip across the model, about 6" long, cut once wherever it shows.
      expect(removed / (6 * 2 * halfWidth * depth)).toBeCloseTo(1, 0);

      expect(cut.boundingBox().max[1]).toBeCloseTo(levels[6], 6);
    });
  });

  it("makes fill bodies that exactly refill the grooves", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const levels = layerLevels(baseY, top, 6);
    const strip = (x: number, key: string) => ({
      key,
      paths: [
        {
          halfWidth: 0.05,
          points: Array.from({ length: 101 }, (_, i): [number, number] => [x, -2.5 + i * 0.05]),
        },
      ],
    });
    const plain = stackTerrain(m, terrain, { levels, baseY }).terrain;
    const { terrain: cut, inlays } = stackTerrain(m, terrain, {
      levels,
      baseY,
      grooves: [strip(0, "black"), strip(0.05, "blue")],
      filamentInlays: true,
    });
    withSolids([terrain, plain, cut, ...inlays.map((i) => i.solid)], () => {
      expect(inlays.map((i) => i.key).sort()).toEqual(["black", "blue"]);
      const filled = inlays.reduce((sum, i) => sum + i.solid.volume(), 0);
      expect(cut.volume() + filled).toBeCloseTo(plain.volume(), 3);
      const [black, blue] = ["black", "blue"].map((k) => inlays.find((i) => i.key === k)!.solid);
      // The higher-priority color keeps the crossing.
      expect(black.volume()).toBeGreaterThan(blue.volume());
      for (const { solid } of inlays) {
        const overlap = m.Manifold.intersection(solid, cut);
        expect(overlap.volume()).toBeLessThan(1e-5);
        overlap.delete();
      }
    });
  });

  it("drops color slivers too narrow to print", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const levels = layerLevels(baseY, top, 3);
    const hairline = {
      key: "blue",
      paths: [{ halfWidth: 0.01, points: Array.from({ length: 41 }, (_, i): [number, number] => [-2 + i * 0.1, 2]) }],
    };
    const { terrain: cut, inlays } = stackTerrain(m, terrain, { levels, baseY, grooves: [hairline], filamentInlays: true });
    withSolids([terrain, cut, ...inlays.map((i) => i.solid)], () => {
      expect(inlays).toHaveLength(0);
    });
  });

  it("stays close to the smooth terrain's volume", () => {
    const terrain = hill();
    const top = terrain.boundingBox().max[1];
    const stacked = stackTerrain(m, terrain, { levels: layerLevels(baseY, top, 16), baseY }).terrain;
    withSolids([terrain, stacked], () => {
      expect(stacked.volume() / terrain.volume()).toBeCloseTo(1, 0);
    });
  });
});
