import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

import { extrudeContours, manifoldFromMesh, vertexDataFromManifold, withSolids } from "./manifold";
import { buildTextSolid, textContours } from "./text";
import { buildShapedWatertight, buildWatertight } from "./watertight";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;
let font: opentype.Font;

beforeAll(async () => {
  m = await Module();
  m.setup();
  const buf = readFileSync(join(process.cwd(), "public/fonts/Roboto-Regular.ttf"));
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
});

const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];

function hill(size: number): ElevationResponse {
  const heights: number[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      const z = (j / (size - 1)) * 2 - 1;
      heights.push(600 + 400 * Math.exp(-(x * x + z * z) * 2));
    }
  }
  return { heights, width: size, height: size, min: 600, max: 1000, source: "usgs", zoom: 0 };
}

const spec = {
  bbox,
  widthInches: 6,
  heightInches: 6,
  baseThicknessInches: 0.25,
  verticalExaggeration: 2,
};

describe("manifoldFromMesh", () => {
  it("accepts the rectangular terrain as a closed solid", () => {
    const { vertexData } = buildWatertight({ ...spec, data: hill(32) });
    const solid = manifoldFromMesh(m, {
      positions: vertexData.positions!,
      indices: vertexData.indices!,
    });
    withSolids([solid], () => {
      expect(solid.status()).toBe("NoError");
      expect(solid.volume()).toBeGreaterThan(6 * 6 * 0.25);
    });
  });

  it("accepts the circle-masked terrain as a closed solid", () => {
    const { vertexData } = buildShapedWatertight({ ...spec, data: hill(32) }, "circle", 0);
    const solid = manifoldFromMesh(m, {
      positions: vertexData.positions!,
      indices: vertexData.indices!,
    });
    withSolids([solid], () => {
      expect(solid.status()).toBe("NoError");
    });
  });

  it("rejects an open mesh", () => {
    const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(() => manifoldFromMesh(m, tri)).toThrow();
  });
});

describe("text solids", () => {
  it("extrudes glyphs with holes into a solid of the right depth", () => {
    const text = buildTextSolid(m, font, "Bob 8", 0.2, 0.05);
    expect(text).not.toBeNull();
    withSolids([text!], () => {
      expect(text!.status()).toBe("NoError");
      const box = text!.boundingBox();
      expect(box.min[2]).toBeCloseTo(0, 5);
      expect(box.max[2]).toBeCloseTo(0.05, 5);
      expect(box.max[1] - box.min[1]).toBeGreaterThan(0.15);
    });
  });

  it("returns null for whitespace", () => {
    expect(textContours(font, " ", 0.2)).toEqual([]);
    expect(buildTextSolid(m, font, " ", 0.2, 0.05)).toBeNull();
  });
});

describe("engraving the underside", () => {
  it("cuts text into the bottom face and stays watertight", () => {
    const { vertexData } = buildWatertight({ ...spec, data: hill(48) });
    const terrain = manifoldFromMesh(m, {
      positions: vertexData.positions!,
      indices: vertexData.indices!,
    });
    const text = buildTextSolid(m, font, "craftedcarving.com", 0.12, 0.05)!;
    const placed = text.translate([-1, -0.06, -0.01]).rotate([-90, 0, 0]);
    const cut = m.Manifold.difference(terrain, placed);
    withSolids([terrain, text, placed, cut], () => {
      expect(cut.status()).toBe("NoError");
      expect(cut.volume()).toBeLessThan(terrain.volume());
      expect(cut.numTri()).toBeGreaterThan(terrain.numTri());
      const vd = vertexDataFromManifold(cut);
      expect(vd.positions!.length / 3).toBe(cut.numTri() * 3);
    });
  });

  it("extrudeContours resolves overlapping outlines", () => {
    const a: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const b: [number, number][] = [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]];
    const solid = extrudeContours(m, [a, b], 1);
    withSolids([solid], () => {
      expect(solid.volume()).toBeCloseTo(1.75, 5);
    });
  });
});
