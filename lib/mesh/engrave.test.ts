import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import type { Shape } from "@/lib/shape";
import type { Bbox } from "@/lib/types";

import { compassRoseContours } from "./compass";
import { buildModelSolids, cutBrand, unionForExport } from "./engrave";
import { extrudeContours, withSolids } from "./manifold";
import {
  buildNameplateSolids,
  fitNameplate,
  plateFacingDeg,
  plateGlyphs,
  plateTextWidth,
  plateTurnDeg,
  roseDiameterInches,
} from "./nameplate";
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

  it("never cuts off a name that fits, whatever the model size", () => {
    // Regression: rounding after the shrink rejected exact fits, turning
    // "Resort" into "Reso…" on about a quarter of sizes.
    for (let w = 3; w < 4.5; w += 0.00137) {
      const layout = fitNameplate(font, {
        shape: "circle",
        widthInches: w,
        heightInches: w,
        rotation: 0,
        label: "Loon Mountain Resort",
        compass: true,
      })!;
      expect(layout.text).toBe("Loon Mountain Resort");
    }
  });

  it("drops generic words before cutting letters", () => {
    const tiny = { shape: "circle" as Shape, widthInches: 2, heightInches: 2, rotation: 0, compass: true };
    expect(fitNameplate(font, { ...tiny, label: "Loon Mountain Resort" })!.text).toBe("Loon Mountain");
    expect(fitNameplate(font, { ...tiny, label: "Bretton Woods Ski Area" })!.text).toBe("Bretton Woods");
  });

  it("uses the part before a comma when the whole name won't fit", () => {
    const layout = fitNameplate(font, {
      shape: "circle",
      widthInches: 3,
      heightInches: 3,
      rotation: 0,
      label: "Mont Tremblant Resort, Station Mont Tremblant",
      compass: true,
    })!;
    expect(layout.text).toBe("Mont Tremblant Resort");
  });

  it("leaves the rose off a face too short for it", () => {
    const layout = fitNameplate(font, {
      shape: "rectangle",
      widthInches: 0.5,
      heightInches: 0.5,
      rotation: 0,
      label: "",
      compass: true,
    });
    expect(layout).toBeNull();
  });

  it("sets the place under the name in smaller letters", () => {
    const plate = { shape: "rectangle" as Shape, ...base, label: "Jay Peak Resort", compass: true };
    const alone = fitNameplate(font, plate)!;
    const layout = fitNameplate(font, { ...plate, place: "Jay, VT" })!;
    expect(layout.text).toBe("Jay Peak Resort");
    expect(layout.place).toBe("Jay, VT");
    // The name gives up height to make room, and neither line drops below 3 mm.
    expect(layout.capInches).toBeLessThan(alone.capInches);
    expect(layout.placeCapInches).toBeLessThan(layout.capInches);
    expect(layout.placeCapInches).toBeGreaterThanOrEqual(3 / 25.4 - 1e-9);
  });

  it("drops the place, not the name, when the two won't fit", () => {
    const tiny = { shape: "circle" as Shape, widthInches: 2, heightInches: 2, rotation: 0, compass: true };
    const alone = fitNameplate(font, { ...tiny, label: "Sugarloaf" })!;
    const layout = fitNameplate(font, { ...tiny, label: "Sugarloaf", place: "Carrabassett Valley, ME" })!;
    expect(layout).toEqual(alone);
    expect(layout.place).toBe("");
  });

  it("gives up a generic word in the name before it gives up the place", () => {
    // Shrinking the plinth squeezes the plate through its stages in order.
    const stages: string[] = [];
    for (let w = 4; w >= 2; w -= 0.02) {
      const layout = fitNameplate(font, {
        shape: "circle",
        widthInches: w,
        heightInches: w,
        rotation: 0,
        label: "Loon Mountain Resort",
        place: "Lincoln, NH",
        compass: true,
      })!;
      const stage = `${layout.text} | ${layout.place}`;
      if (stages.at(-1) !== stage) stages.push(stage);
    }
    expect(stages.slice(0, 2)).toEqual([
      "Loon Mountain Resort | Lincoln, NH",
      "Loon Mountain | Lincoln, NH",
    ]);
  });

  it("treats a place with no name as the name", () => {
    const layout = fitNameplate(font, { shape: "rectangle", ...base, label: "", place: "Jay, VT", compass: true })!;
    expect(layout.text).toBe("Jay, VT");
    expect(layout.place).toBe("");
  });

  it("starts both lines at the same left edge, centered top to bottom as a pair", () => {
    const layout = fitNameplate(font, { shape: "rectangle", ...base, label: "HILL", place: "HIGH", compass: true })!;
    const glyphs = plateGlyphs(font, layout);
    expect(glyphs).toHaveLength(8);
    const edges = (g: (typeof glyphs)[number]) => {
      const xs = g.contours.flat().map(([x]) => x + g.centerX);
      const ys = g.contours.flat().map(([, y]) => y);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) };
    };
    const nameH = edges(glyphs[0]);
    const placeH = edges(glyphs[4]);
    // Same letter at two sizes: the stems line up to within the letter's own side bearing.
    expect(Math.abs(nameH.left - placeH.left)).toBeLessThan(0.1 * layout.capInches);
    expect(placeH.top).toBeLessThan(nameH.bottom);
    // The rose sits at zero, so the pair has to straddle it evenly.
    expect(nameH.top).toBeCloseTo(-placeH.bottom, 6);
    expect(nameH.top - nameH.bottom).toBeCloseTo(layout.capInches, 3);
    expect(placeH.top - placeH.bottom).toBeCloseTo(layout.placeCapInches, 3);
    const right = Math.max(...glyphs.map((g) => edges(g).right));
    expect(right).toBeLessThanOrEqual(plateTextWidth(font, layout) + 1e-9);
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

  it("snaps to faces: 90° on rectangles, 60° on hexagons, whole degrees on circles", () => {
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 130 })).toBe(90);
    expect(plateTurnDeg({ ...rect, rotation: 0, facing: 140 })).toBe(0);
    const hex = { shape: "hexagon" as Shape, widthInches: 6, heightInches: 5.2 };
    expect(plateTurnDeg({ ...hex, rotation: 0, facing: 45 })).toBe(120);
    expect(plateTurnDeg({ ...hex, rotation: -30, facing: 45 })).toBe(180);
    expect(plateTurnDeg({ ...hex, rotation: 450, facing: 0 })).toBe(120);
    expect(plateTurnDeg({ shape: "circle", widthInches: 6, heightInches: 6, rotation: 0, facing: 45.4 })).toBe(135);
  });

  it("treats a facing that is not a number as none", () => {
    expect(plateTurnDeg({ ...rect, rotation: 20, facing: NaN })).toBe(0);
    expect(plateTurnDeg({ ...rect, rotation: 20, facing: Infinity })).toBe(0);
  });

  it("reports the bearing the snapped plate actually faces, and that is a fixed point", () => {
    const side = { ...rect, rotation: 30, facing: 100 };
    const snapped = plateFacingDeg(side);
    expect(snapped).toBe(60);
    expect(plateFacingDeg({ ...side, facing: snapped })).toBe(snapped);
    expect(plateTurnDeg({ ...side, facing: snapped })).toBe(plateTurnDeg(side));
  });
});

describe("compassRoseContours", () => {
  const diameter = 16 / 25.4;

  it.each([0, 37, 90, 133, -200])("stays inside its circle turned %d°", (turn) => {
    const contours = compassRoseContours(m, font, diameter, turn);
    // Four letters (none has a counter) and the star.
    expect(contours).toHaveLength(5);
    for (const [x, y] of contours.flat()) {
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(diameter / 2 + 1e-6);
    }
  });

  it("keeps the letters clear of the star", () => {
    for (const turn of [0, 22, 45, 67, 90]) {
      const contours = compassRoseContours(m, font, diameter, turn);
      const star = contours.at(-1)!;
      const letters = m.CrossSection.compose(
        contours.slice(0, -1).map((c) => new m.CrossSection([c], "NonZero")),
      );
      const starSection = new m.CrossSection([star], "NonZero");
      const overlap = m.CrossSection.intersection(letters, starSection);
      expect(overlap.area()).toBe(0);
      expect(starSection.area()).toBeGreaterThan(0);
      for (const s of [letters, starSection, overlap]) s.delete();
    }
  });
});

describe("buildNameplateSolids", () => {
  it("places every glyph and the rose on the frame's bottom edge by default", () => {
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

  it("cuts both lines into the face with the rose to their right", () => {
    const { solids, layout } = buildNameplateSolids(m, font, {
      shape: "rectangle",
      ...base,
      label: "HILL",
      place: "HIGH",
      compass: true,
    });
    withSolids(solids, () => {
      expect(layout?.place).toBe("HIGH");
      expect(solids).toHaveLength(9);
      const boxes = solids.map((s) => s.boundingBox());
      const rose = boxes[8];
      const mid = (box: (typeof boxes)[number], axis: number) => (box.min[axis] + box.max[axis]) / 2;
      for (const box of boxes.slice(0, 8)) expect(box.max[0]).toBeLessThan(rose.min[0]);
      // The name sits higher up the chamfer than the place, and the rose
      // between the top of one and the bottom of the other.
      for (let i = 0; i < 4; i++) expect(mid(boxes[i], 1)).toBeGreaterThan(mid(boxes[4 + i], 1));
      expect(mid(rose, 1)).toBeLessThan(boxes[0].max[1]);
      expect(mid(rose, 1)).toBeGreaterThan(boxes[4].min[1]);
      // A plate with no place leaves the rose exactly where this one has it.
      const plain = buildNameplateSolids(m, font, { shape: "rectangle", ...base, label: "HILL", compass: true });
      withSolids(plain.solids, () => {
        const plainRose = plain.solids[4].boundingBox();
        expect(mid(plainRose, 1)).toBeCloseTo(mid(rose, 1), 6);
        expect(mid(plainRose, 2)).toBeCloseTo(mid(rose, 2), 6);
      });
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

  it("keeps the rose on true north wherever the plate sits", () => {
    const { solids } = buildNameplateSolids(m, font, {
      shape: "rectangle",
      ...base,
      facing: 90,
      label: "",
      compass: true,
    });
    const diameter = roseDiameterInches();
    const cut = 0.45 * (diameter / 2);
    // On the east face north runs along the face toward +z, so a slice
    // past the star on that side holds the N and the other holds the S.
    // In the rose's own frame that face turns it 90° clockwise, north to +x.
    const flat = extrudeContours(m, compassRoseContours(m, font, diameter, -90), 1);
    const flatNorth = flat.trimByPlane([1, 0, 0], cut);
    const flatSouth = flat.trimByPlane([-1, 0, 0], cut);
    const placedNorth = solids[0].trimByPlane([0, 0, 1], cut);
    const placedSouth = solids[0].trimByPlane([0, 0, -1], cut);
    withSolids([...solids, flat, flatNorth, flatSouth, placedNorth, placedSouth], () => {
      expect(solids).toHaveLength(1);
      const expected = flatNorth.volume() / flatSouth.volume();
      expect(Math.abs(expected - 1)).toBeGreaterThan(0.02);
      expect(placedNorth.volume() / placedSouth.volume()).toBeCloseTo(expected, 2);
    });
  });

  it("gives a hexagon's rose the next face and the name its own", () => {
    const hex = { shape: "hexagon" as Shape, widthInches: 3, heightInches: 3 * 0.866, rotation: 0, compass: true };
    const label = "Stowe Mountain";
    expect(fitNameplate(font, { ...hex, label })!.text).toBe(label);
    const { solids } = buildNameplateSolids(m, font, { ...hex, label });
    withSolids(solids, () => {
      const box = solids.at(-1)!.boundingBox();
      const bearing = (Math.atan2(box.min[0] + box.max[0], box.min[2] + box.max[2]) * 180) / Math.PI;
      expect(bearing).toBeCloseTo(120, -1);
      const nameBox = solids[0].boundingBox();
      expect(nameBox.min[2]).toBeLessThan(-(1.5 * 0.866));
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
      // One per visible glyph (the space has no outline) plus the rose.
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

  it("turns the brand with the plate", () => {
    const plain = buildPlinthSolid(m, { shape: "rectangle", ...base, widthInches: 8 });
    const south = cutBrand(m, font, plain, 0)!;
    const east = cutBrand(m, font, plain, 90)!;
    withSolids([plain, south, east], () => {
      // Same material removed either way, but the pocket lies along a
      // different axis: the text is wider than it is tall.
      expect(east.volume()).toBeCloseTo(south.volume(), 4);
      const extent = (s: typeof plain, axis: number) => {
        const diff = m.Manifold.difference(plain, s);
        const box = diff.boundingBox();
        diff.delete();
        return box.max[axis] - box.min[axis];
      };
      expect(extent(south, 0)).toBeGreaterThan(extent(south, 2) * 3);
      expect(extent(east, 2)).toBeGreaterThan(extent(east, 0) * 3);
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
