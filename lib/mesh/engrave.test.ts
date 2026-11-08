import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Shape } from "@/lib/shape";
import type { Bbox } from "@/lib/types";

import { buildModelSolids, unionForExport } from "./engrave";
import { withSolids } from "./manifold";
import { buildNameplateSolids, fitNameplate, plateTurnDeg } from "./nameplate";
import { buildPlinthSolid, plinthHeightInches, RIM_IN } from "./plinth";
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

const base = { widthInches: 6, heightInches: 6, rotation: 0 };

describe("buildPlinthSolid", () => {
  it.each<Shape>(["rectangle", "circle", "hexagon"])("%s plinth is a frustum of the right size", (shape) => {
    const h = plinthHeightInches();
    const solid = buildPlinthSolid(m, { shape, ...base, heightInches: shape === "hexagon" ? 6 * 0.866 : 6 });
    withSolids([solid], () => {
      expect(solid.status()).toBe("NoError");
      const box = solid.boundingBox();
      expect(box.min[1]).toBeCloseTo(0, 5);
      expect(box.max[1]).toBeCloseTo(h, 5);
      // Bottom is the footprint plus the rim on each side; a mitered
      // hexagon corner reaches rim / cos 30° past its vertex.
      const reach = shape === "hexagon" ? RIM_IN / Math.cos(Math.PI / 6) : RIM_IN;
      expect(box.max[0] - box.min[0]).toBeCloseTo(6 + 2 * reach, 2);
    });
  });

  it("follows the model rotation", () => {
    const solid = buildPlinthSolid(m, { shape: "rectangle", ...base, widthInches: 8, rotation: 90 });
    withSolids([solid], () => {
      const box = solid.boundingBox();
      expect(box.max[2] - box.min[2]).toBeCloseTo(8 + 2 * RIM_IN, 3);
    });
  });
});

describe("fitNameplate", () => {
  it("sizes caps from the chamfer and keeps a short name at full size", () => {
    const layout = fitNameplate(font, { shape: "rectangle", ...base, label: "Jay Peak", compass: true })!;
    expect(layout.capInches).toBeGreaterThan(3 / 25.4);
    expect(layout.capInches).toBeLessThanOrEqual(9 / 25.4);
    expect(layout.text).toBe("Jay Peak");
  });

  it("shrinks, then shortens, a long name on a small face", () => {
    const small = { shape: "hexagon" as Shape, widthInches: 3, heightInches: 2.6, rotation: 0 };
    const layout = fitNameplate(font, { ...small, label: "Dolomiti Superski Alta Badia", compass: true })!;
    expect(layout.capInches).toBeCloseTo(3 / 25.4, 5);
    expect(layout.text.endsWith("…")).toBe(true);
    expect(layout.text.length).toBeLessThan("Dolomiti Superski Alta Badia".length);
  });

  it("returns null with nothing to show", () => {
    expect(fitNameplate(font, { shape: "rectangle", ...base, label: "  ", compass: false })).toBeNull();
  });
});

describe("plateTurnDeg", () => {
  const rect = { shape: "rectangle" as Shape, widthInches: 6, heightInches: 4 };

  it("stays on the frame's bottom edge without a facing", () => {
    expect(plateTurnDeg({ ...rect, rotation: 0 })).toBe(0);
    expect(plateTurnDeg({ ...rect, rotation: 37 })).toBe(0);
  });

  it("undoes the model rotation to face a bearing", () => {
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 180 })).toBe(0);
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 90 })).toBe(90);
    expect(plateTurnDeg({ ...rect, rotation: 90, facing: 90 })).toBe(0);
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 0 })).toBe(180);
  });

  it("snaps to faces: 90° on rectangles, 60° on hexagons, none on circles", () => {
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 130 })).toBe(90);
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 140 })).toBe(0);
    expect(plateTurnDeg({ shape: "hexagon", widthInches: 6, heightInches: 5.2, rotation: 0, facing: 45 })).toBe(120);
    expect(plateTurnDeg({ shape: "circle", widthInches: 6, heightInches: 6, rotation: 0, facing: 45 })).toBe(135);
  });
});

describe("buildNameplateSolids", () => {
  it("places every glyph and the arrow on the frame's bottom edge by default", () => {
    const { solids, layout } = buildNameplateSolids(m, font, {
      shape: "rectangle",
      ...base,
      label: "Jay",
      compass: true,
    });
    withSolids(solids, () => {
      expect(layout?.text).toBe("Jay");
      expect(solids).toHaveLength(4);
      const h = plinthHeightInches();
      for (const s of solids) {
        const box = s.boundingBox();
        // South of the footprint, inside the rim, straddling mid-height.
        expect(box.max[2]).toBeLessThan(-3 + 0.05);
        expect(box.min[2]).toBeGreaterThan(-3 - RIM_IN - 0.1);
        expect(box.min[1]).toBeLessThan(h / 2);
        expect(box.max[1]).toBeGreaterThan(h / 2);
      }
    });
  });

  it("moves to the face nearest the resort's base side", () => {
    // 8 wide, 6 tall, turned 90°: the long edges now run north-south,
    // and the base lies east.
    const { solids } = buildNameplateSolids(m, font, {
      shape: "rectangle",
      ...base,
      widthInches: 8,
      rotation: 90,
      facing: 90,
      label: "Stowe",
      compass: true,
    });
    withSolids(solids, () => {
      for (const s of solids) {
        const box = s.boundingBox();
        expect(box.min[0]).toBeGreaterThan(3 - 0.05);
        expect(box.max[0]).toBeLessThan(3 + RIM_IN + 0.1);
      }
      // The plate spans the 8" face, not a 6" one.
      const zs = solids.flatMap((s) => [s.boundingBox().min[2], s.boundingBox().max[2]]);
      expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(1);
    });
  });

  it("keeps the arrow on true north wherever the plate sits", () => {
    const { solids } = buildNameplateSolids(m, font, {
      shape: "rectangle",
      ...base,
      facing: 90,
      label: "",
      compass: true,
    });
    withSolids(solids, () => {
      expect(solids).toHaveLength(1);
      // On the east face the arrow lies along z. Its tip reaches r
      // past center and the stem 0.85 r the other way, so the longer
      // reach must be north.
      const box = solids[0].boundingBox();
      expect(box.max[2]).toBeGreaterThan(0);
      expect(box.max[2] / -box.min[2]).toBeCloseTo(1 / 0.85, 1);
    });
  });

  it("wraps around a circular plinth", () => {
    const { solids } = buildNameplateSolids(m, font, {
      shape: "circle",
      ...base,
      label: "Mont Tremblant",
      compass: true,
    });
    withSolids(solids, () => {
      const r = 3 + RIM_IN / 2;
      for (const s of solids) {
        const box = s.boundingBox();
        const cx = (box.min[0] + box.max[0]) / 2;
        const cz = (box.min[2] + box.max[2]) / 2;
        expect(Math.hypot(cx, cz)).toBeCloseTo(r, 0);
        expect(cz).toBeLessThan(0);
      }
    });
  });
});

describe("buildModelSolids", () => {
  it("builds plinth, pockets, inlays and brand into watertight solids", () => {
    const { vertexData } = buildWatertight({ ...base, bbox, data: hill(40), baseThicknessInches: 0.25, verticalExaggeration: 2 });
    const built = buildModelSolids(
      m,
      font,
      { positions: vertexData.positions!, indices: vertexData.indices! },
      { shape: "rectangle", ...base, label: "Jay Peak", plinth: true, brand: true },
    );
    const union = unionForExport(m, built);
    withSolids([built.terrain, built.plinth!, ...built.inlays, union], () => {
      expect(built.plinth!.status()).toBe("NoError");
      // One per visible glyph (the space has no outline) plus the arrow.
      expect(built.inlays.length).toBe(built.nameplate!.text.replace(/\s/g, "").length + 1);
      for (const inlay of built.inlays) expect(inlay.volume()).toBeGreaterThan(0);
      // Pockets and brand both remove material from the plinth.
      const plain = buildPlinthSolid(m, { shape: "rectangle", ...base });
      expect(built.plinth!.volume()).toBeLessThan(plain.volume());
      plain.delete();
      expect(union.status()).toBe("NoError");
      expect(union.volume()).toBeCloseTo(built.terrain.volume() + built.plinth!.volume(), 3);
    });
  });

  it("brands the terrain when there is no plinth", () => {
    const { vertexData } = buildShapedWatertight(
      { ...base, bbox, data: hill(40), baseThicknessInches: 0.25, verticalExaggeration: 2 },
      "circle",
      0,
    );
    const built = buildModelSolids(
      m,
      font,
      { positions: vertexData.positions!, indices: vertexData.indices! },
      { shape: "circle", ...base, label: "", plinth: false, brand: true },
    );
    withSolids([built.terrain], () => {
      expect(built.plinth).toBeNull();
      expect(built.plinthHeight).toBe(0);
      expect(built.terrain.status()).toBe("NoError");
    });
  });
});
