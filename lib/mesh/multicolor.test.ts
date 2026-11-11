import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";

import type { BuiltModel } from "./engrave";
import { buildColorBodies } from "./multicolor";
import { buildThreeMf } from "./three-mf";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;

beforeAll(async () => {
  m = await Module();
  m.setup();
});

function fakeBuilt(keys: string[]): BuiltModel {
  return {
    terrain: m.Manifold.cube([4, 2, 4]).translate([-2, 0, -2]),
    plinth: m.Manifold.cube([6, 0.2, 6]).translate([-3, 0, -3]),
    inlays: [m.Manifold.cube([0.1, 0.02, 0.1])],
    grooveInlays: keys.map((key, i) => ({ key, solid: m.Manifold.cube([0.1, 0.02, 0.1]).translate([i, 1.5, 0]) })),
    plinthHeight: 0.2,
    nameplate: null,
  };
}

function free(built: BuiltModel) {
  built.terrain.delete();
  built.plinth?.delete();
  for (const s of built.inlays) s.delete();
  for (const i of built.grooveInlays) i.solid.delete();
}

const layers = { levels: [0.5, 1, 1.5, 2, 2.5, 3], baseY: 0.25 };

describe("buildColorBodies", () => {
  it("fits North American trails in one AMS", () => {
    const built = fakeBuilt(["lift", "black", "blue", "green", "gray"]);
    const { parts, filaments } = buildColorBodies(m, built, layers, false);
    free(built);
    expect(filaments.map((f) => f.name)).toEqual(["White", "Green", "Blue", "Black"]);
    expect(parts.map((p) => p.filament)).toEqual([1, 2, 3, 4]);
  });

  it("fits European trails in one AMS", () => {
    const built = fakeBuilt(["lift", "black", "red", "orange", "blue", "green", "gray"]);
    const { filaments } = buildColorBodies(m, built, layers, false);
    free(built);
    expect(filaments.map((f) => f.name)).toEqual(["White", "Blue", "Red", "Black"]);
  });

  it("keeps every color and adds forest with a second AMS", () => {
    const built = fakeBuilt(["lift", "black", "blue", "green"]);
    const { parts, filaments } = buildColorBodies(m, built, layers, true);
    free(built);
    expect(filaments.map((f) => f.name)).toEqual(["White", "Forest green", "Green", "Blue", "Gray", "Black"]);
    const forest = parts[1];
    let topZ = -Infinity;
    for (let i = 1; i < forest.positions.length; i += forest.positionStride) {
      topZ = Math.max(topZ, forest.positions[i]);
    }
    expect(topZ).toBeCloseTo(layers.levels[3] + 0.2, 5);
  });

  it("leaves out a color that comes out empty", () => {
    const built = fakeBuilt(["blue"]);
    const allAboveTreeline = { levels: [-9, -8, -7, -6, -5, -4], baseY: 0.25 };
    const { parts, filaments } = buildColorBodies(m, built, allAboveTreeline, true);
    free(built);
    expect(filaments.map((f) => f.name)).toEqual(["White", "Blue", "Black"]);
    expect(parts.map((p) => p.filament)).toEqual([1, 2, 3]);
  });

  it("never needs more than eight filaments", () => {
    const built = fakeBuilt(["lift", "black", "red", "orange", "blue", "green", "gray"]);
    const { filaments } = buildColorBodies(m, built, layers, true);
    free(built);
    expect(filaments.length).toBeLessThanOrEqual(8);
  });

  it("keeps mesh data readable after its solids are freed", async () => {
    const built = fakeBuilt(["blue"]);
    const bodies = buildColorBodies(m, built, null, false);
    free(built);
    for (let i = 0; i < 50; i++) m.Manifold.cube([1, 1, 1]).delete();
    const blob = await buildThreeMf("T", bodies.parts, bodies.filaments);
    expect(blob.size).toBeGreaterThan(100);
    expect(Array.from(bodies.parts[0].positions).some((v) => v !== 0)).toBe(true);
  });
});
