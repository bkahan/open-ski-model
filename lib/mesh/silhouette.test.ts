import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

import { buildModelSolids, terrainBaseInches, unionForExport } from "./engrave";
import { withSolids } from "./manifold";
import { TERRAIN_SEAT_IN } from "./plinth";
import {
  buildOutlinePlinth,
  buildResortOutline,
  OUTLINE_PLINTH_HEIGHT_IN,
  outlineMask,
} from "./silhouette";
import type { Contour } from "./text";
import { buildWatertight, lowestKeptElevation } from "./watertight";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;
let font: opentype.Font;

beforeAll(async () => {
  m = await Module();
  m.setup();
  const buf = readFileSync(join(process.cwd(), "public/fonts/Roboto-Regular.ttf"));
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
});

const frame: Contour = [
  [-3, -3],
  [3, -3],
  [3, 3],
  [-3, 3],
];

function bounds(ring: Contour) {
  const xs = ring.map(([x]) => x);
  const zs = ring.map(([, z]) => z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

describe("buildResortOutline", () => {
  const trail = (x: number): Array<[number, number]> => [
    [x, -1.5],
    [x, 1.5],
  ];

  it("returns null with no lines", () => {
    expect(buildResortOutline(m, [], frame, 6)).toBeNull();
    expect(
      buildResortOutline(m, [[[1, 1], [1, 1]]], frame, 6),
    ).toBeNull();
  });

  it("wraps nearby trails in one ring with a margin", () => {
    const ring = buildResortOutline(m, [trail(-0.4), trail(0.4)], frame, 6)!;
    const box = bounds(ring);
    expect(box.minX).toBeCloseTo(-0.4 - 0.18, 2);
    expect(box.maxX).toBeCloseTo(0.4 + 0.18, 2);
    const inside = outlineMask(ring, 6, 6, 241, 241);
    expect(inside(0, 0)).toBe(true);
    expect(inside(1.5, 0)).toBe(false);
  });

  it("drops a detached cluster", () => {
    const ring = buildResortOutline(m, [trail(-2), [[2.4, -0.2], [2.4, 0.2]]], frame, 6)!;
    expect(bounds(ring).maxX).toBeLessThan(0);
  });

  it("fills the middle of a loop of trails", () => {
    const loop: Array<[number, number]> = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [-2, -2],
    ];
    const ring = buildResortOutline(m, [loop], frame, 6)!;
    expect(outlineMask(ring, 6, 6, 241, 241)(0, 0)).toBe(true);
  });

  it("stays inside the frame", () => {
    const box = bounds(buildResortOutline(m, [[[-5, 0], [5, 0]]], frame, 6)!);
    expect(box.minX).toBeCloseTo(-3, 5);
    expect(box.maxX).toBeCloseTo(3, 5);
  });
});

describe("buildOutlinePlinth", () => {
  const outline = buildCrescent();

  function buildCrescent(): Contour {
    const ring: Contour = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r = 2.5 + 0.5 * Math.cos(3 * a);
      ring.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return ring;
  }

  it.each([180, 90, 37])("is one solid with the tab on bearing %d", (facing) => {
    const built = buildOutlinePlinth(m, font, { outline, label: "Loon Mountain Resort", compass: true, facing });
    const parts = built.slab.decompose();
    withSolids([built.slab, ...built.solids, ...parts], () => {
      expect(built.slab.status()).toBe("NoError");
      expect(built.slab.volume()).toBeGreaterThan(0);
      expect(parts).toHaveLength(1);
      expect(built.layout?.text).toBe("Loon Mountain Resort");
      expect(built.solids).toHaveLength("LoonMountainResort".length + 1);

      const a = (facing * Math.PI) / 180;
      const toward = (x: number, z: number) => x * Math.sin(a) + z * Math.cos(a);
      const front = Math.max(...outline.map(([x, z]) => toward(x, z)));
      for (const s of built.solids) {
        const box = s.boundingBox();
        const cx = (box.min[0] + box.max[0]) / 2;
        const cz = (box.min[2] + box.max[2]) / 2;
        expect(toward(cx, cz)).toBeGreaterThan(front);
        expect(box.max[1]).toBeGreaterThan(OUTLINE_PLINTH_HEIGHT_IN);
        expect(box.min[1]).toBeGreaterThan(0);
      }
    });
  });
});

describe("buildOutlinePlinth with a place line", () => {
  const outline: Contour = Array.from({ length: 48 }, (_, i): [number, number] => {
    const a = (i / 48) * Math.PI * 2;
    return [2.5 * Math.cos(a), 2.5 * Math.sin(a)];
  });

  it("sets the place under the name and the rose beside the pair, all on the tab", () => {
    const built = buildOutlinePlinth(m, font, {
      outline,
      label: "Sugarloaf",
      place: "Carrabassett Valley, ME",
      compass: true,
    });
    withSolids([built.slab, ...built.solids], () => {
      expect(built.layout?.text).toBe("Sugarloaf");
      expect(built.layout?.place).toBe("CARRABASSETT VALLEY, ME");
      const letters = "Sugarloaf".length + "CarrabassettValley,ME".length;
      expect(built.solids).toHaveLength(letters + 1);

      const slab = built.slab.boundingBox();
      const boxes = built.solids.map((s) => s.boundingBox());
      const rose = boxes[letters];
      const midZ = (box: (typeof boxes)[number]) => (box.min[2] + box.max[2]) / 2;
      for (const box of boxes) {
        // Every pocket is cut into the slab, not hanging off the tab's end.
        expect(box.min[0]).toBeGreaterThan(slab.min[0]);
        expect(box.max[0]).toBeLessThan(slab.max[0]);
        expect(box.min[2]).toBeGreaterThan(slab.min[2]);
      }
      for (const box of boxes.slice(0, letters)) expect(box.max[0]).toBeLessThan(rose.min[0]);
      // The tab faces south, so the name is the line nearer the model.
      const nameZ = midZ(boxes[0]);
      const placeZ = midZ(boxes["Sugarloaf".length]);
      expect(nameZ).toBeGreaterThan(placeZ);
      expect(midZ(rose)).toBeLessThan(boxes[0].max[2]);
      expect(midZ(rose)).toBeGreaterThan(boxes["Sugarloaf".length].min[2]);
    });
  });

  it("leaves the place off a tab too short for it and sets the name as before", () => {
    const small = outline.map(([x, z]): [number, number] => [x * 0.4, z * 0.4]);
    const plain = buildOutlinePlinth(m, font, { outline: small, label: "Alta", compass: true });
    const built = buildOutlinePlinth(m, font, {
      outline: small,
      label: "Alta",
      place: "Little Cottonwood Canyon, UT",
      compass: true,
    });
    withSolids([plain.slab, ...plain.solids, built.slab, ...built.solids], () => {
      expect(built.layout).toEqual(plain.layout);
      expect(built.layout?.place).toBe("");
      expect(built.solids).toHaveLength("Alta".length + 1);
    });
  });
});

describe("buildModelSolids with an outline", () => {
  const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];
  const size = 40;
  const heights: number[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      const z = (j / (size - 1)) * 2 - 1;
      heights.push(600 + 400 * Math.exp(-(x * x + z * z) * 2));
    }
  }
  const data: ElevationResponse = { heights, width: size, height: size, min: 600, max: 1000, source: "usgs", zoom: 0 };
  const base = { widthInches: 6, heightInches: 6, rotation: 0 };
  const outline: Contour = [
    [-2, -1.5],
    [2, -1.5],
    [1.5, 2],
    [-1, 2],
  ];

  it("cuts the terrain to the ring and builds a valid solid", () => {
    const { vertexData } = buildWatertight({ ...base, bbox, data, baseThicknessInches: 0.25, verticalExaggeration: 2 });
    const built = buildModelSolids(
      m,
      font,
      { positions: vertexData.positions!, indices: vertexData.indices! },
      { shape: "rectangle", ...base, label: "Jay Peak", plinth: true, brand: true, outline },
    );
    const union = unionForExport(m, built);
    withSolids([built.terrain, built.plinth!, ...built.inlays, union], () => {
      const box = built.terrain.boundingBox();
      expect(box.min[0]).toBeCloseTo(-2, 3);
      expect(box.max[0]).toBeCloseTo(2, 3);
      expect(box.min[2]).toBeCloseTo(-1.5, 3);
      expect(box.max[2]).toBeCloseTo(2, 3);
      expect(built.terrainLift).toBeCloseTo(OUTLINE_PLINTH_HEIGHT_IN - TERRAIN_SEAT_IN, 6);
      expect(union.status()).toBe("NoError");
      expect(union.decompose().map((s) => { const v = s.volume(); s.delete(); return v; })).toHaveLength(1);
      expect(built.inlays.length).toBe("JayPeak".length + 1);
    });
  });

  it("starts the cut mountain at the plinth's top, whatever lies lower outside the ring", () => {
    // The ring keeps the hill's middle; the frame's corners are far lower.
    const inside = outlineMask(outline, base.widthInches, base.heightInches, size, size);
    const floorElevation = lowestKeptElevation(data, base.widthInches, base.heightInches, inside);
    expect(floorElevation).toBeGreaterThan(data.min + 20);
    const { vertexData, inPerMeter } = buildWatertight({
      ...base,
      bbox,
      data,
      baseThicknessInches: terrainBaseInches({ plinth: true, plinthLiftInches: 0, baseThicknessInches: 0.25 }),
      verticalExaggeration: 2,
      floorElevation,
    });
    const built = buildModelSolids(
      m,
      font,
      { positions: vertexData.positions!, indices: vertexData.indices! },
      { shape: "rectangle", ...base, label: "Jay Peak", plinth: true, brand: true, outline },
    );
    const union = unionForExport(m, built);
    withSolids([built.terrain, built.plinth!, ...built.inlays, union], () => {
      const mesh = built.terrain.getMesh();
      let lowestSurface = Infinity;
      for (let v = 0; v < mesh.numVert; v++) {
        const y = mesh.vertProperties[v * mesh.numProp + 1];
        if (y > 1e-6) lowestSurface = Math.min(lowestSurface, y);
      }
      // No ground below the plinth's top, and no more wall above it than one grid cell can rise.
      const aboveTop = lowestSurface + built.terrainLift - OUTLINE_PLINTH_HEIGHT_IN;
      const steepestCellRise = 60 * inPerMeter * 2;
      expect(aboveTop).toBeGreaterThan(-1e-6);
      expect(aboveTop).toBeLessThan(steepestCellRise);
      expect(union.status()).toBe("NoError");
      expect(union.decompose().map((s) => { const v = s.volume(); s.delete(); return v; })).toHaveLength(1);
    });
  });

  it("cuts without a plinth too", () => {
    const { vertexData } = buildWatertight({ ...base, bbox, data, baseThicknessInches: 0.25, verticalExaggeration: 2 });
    const built = buildModelSolids(
      m,
      font,
      { positions: vertexData.positions!, indices: vertexData.indices! },
      { shape: "rectangle", ...base, label: "", plinth: false, brand: true, outline },
    );
    withSolids([built.terrain], () => {
      expect(built.plinth).toBeNull();
      expect(built.terrain.status()).toBe("NoError");
      expect(built.terrain.volume()).toBeGreaterThan(0);
    });
  });
});
