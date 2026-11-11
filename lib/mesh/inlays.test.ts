import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import type { CrossSection, Manifold } from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ElevationResponse } from "@/lib/elevation/types";
import { shapeOutline } from "@/lib/shape";
import type { Bbox } from "@/lib/types";

import { buildModelSolids } from "./engrave";
import { INLAY_DEPTH_IN, inlayTerrain, planColors, type ColorPlan, type InlayGroup } from "./inlays";
import { manifoldFromMesh } from "./manifold";
import { buildWatertight } from "./watertight";

type Toplevel = Awaited<ReturnType<typeof Module>>;
let m: Toplevel;
let font: opentype.Font;

beforeAll(async () => {
  m = await Module();
  m.setup();
  const buf = readFileSync(join(process.cwd(), "public/fonts/Roboto-Regular.ttf"));
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
});

const MM = 1 / 25.4;
const SIZE_IN = 6;
const BASE_IN = 0.25;
const bbox: Bbox = [-72.53, 44.91, -72.47, 44.95];
const footprint = shapeOutline("rectangle", SIZE_IN, SIZE_IN, 0);
/** A ten-thousandth of a square millimeter: nothing a printer could show. */
const CLIPPING_NOISE_IN2 = 1e-4 * MM * MM;

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

function hillMesh() {
  const { vertexData } = buildWatertight({
    bbox,
    data: hill(96),
    widthInches: SIZE_IN,
    heightInches: SIZE_IN,
    baseThicknessInches: BASE_IN,
    verticalExaggeration: 3,
  });
  return { positions: vertexData.positions!, indices: vertexData.indices! };
}

function hillTerrain(): Manifold {
  return manifoldFromMesh(m, hillMesh());
}

const line = (from: [number, number], to: [number, number], widthMm: number) => ({
  points: [from, to],
  halfWidth: (widthMm * MM) / 2,
});

/** A lift straight up the hill, a black run crossing it, a blue run looping round, a green off to one side. */
const resort: InlayGroup[] = [
  { key: "lift", paths: [line([0, -2.2], [0, 2.2], 1.2)] },
  { key: "black", paths: [line([-2.2, 0.3], [2.2, -0.3], 1.6)] },
  {
    key: "blue",
    paths: [
      {
        points: Array.from({ length: 41 }, (_, i): [number, number] => {
          const a = (i / 40) * Math.PI * 2;
          return [1.5 * Math.cos(a), 1.5 * Math.sin(a)];
        }),
        halfWidth: (1.6 * MM) / 2,
      },
    ],
  },
  { key: "green", paths: [line([-2.5, -2.5], [-1, -2.2], 1.6)] },
];

function freePlans(plans: ColorPlan[]) {
  for (const { section } of plans) section.delete();
}

/** Area of the parts of `section` narrower than `widthIn`. */
function thinArea(section: CrossSection, widthIn: number): number {
  const shrunk = section.offset(-widthIn / 2, "Round", 2, 12);
  const back = shrunk.offset(widthIn / 2, "Round", 2, 12);
  const thin = section.subtract(back);
  const area = thin.area();
  for (const s of [shrunk, back, thin]) s.delete();
  return area;
}

function free(solids: Manifold[]) {
  for (const s of solids) s.delete();
}

describe("planColors", () => {
  it("gives a crossing to the higher-priority color and overlaps nothing", () => {
    const plans = planColors(m, footprint, { groups: resort });
    expect(plans.map((p) => p.key)).toEqual(["lift", "black", "blue", "green"]);
    for (let a = 0; a < plans.length; a++) {
      for (let b = a + 1; b < plans.length; b++) {
        const both = plans[a].section.intersect(plans[b].section);
        expect(both.area()).toBeLessThan(CLIPPING_NOISE_IN2);
        both.delete();
      }
    }
    // The lift runs unbroken through the black run that crosses it.
    const lift = plans[0].section.decompose();
    expect(lift).toHaveLength(1);
    for (const piece of lift) piece.delete();
    const black = plans[1].section.decompose();
    expect(black).toHaveLength(2);
    for (const piece of black) piece.delete();
    freePlans(plans);
  });

  it("stops color short of the model's edge", () => {
    // A lift drawn right off both ends of the model.
    const overshoot: InlayGroup[] = [{ key: "lift", paths: [line([0, -3.5], [0, 3.5], 1.2)] }];
    const edge = SIZE_IN / 2;

    const plans = planColors(m, footprint, { groups: overshoot });
    const kept = plans[0].section.bounds();
    expect(kept.min[1]).toBeCloseTo(-edge + 0.8 * MM, 3);
    expect(kept.max[1]).toBeCloseTo(edge - 0.8 * MM, 3);
    freePlans(plans);

    const wider = planColors(m, footprint, { groups: overshoot, edgeMarginInches: 1 * MM });
    const narrowed = wider[0].section.bounds();
    expect(narrowed.min[1]).toBeCloseTo(-edge + 1.8 * MM, 3);
    expect(narrowed.max[1]).toBeCloseTo(edge - 1.8 * MM, 3);
    freePlans(wider);
  });

  it("ignores groups and paths with nothing in them", () => {
    const plans = planColors(m, footprint, {
      groups: [
        { key: "black", paths: [] },
        { key: "blue", paths: [{ points: [], halfWidth: 0.6 * MM }] },
        { key: "green", paths: [line([-2, 0], [2, 0], 1.2)] },
      ],
    });
    expect(plans.map((p) => p.key)).toEqual(["green"]);
    freePlans(plans);
    const none = planColors(m, footprint, { groups: [] });
    expect(none).toHaveLength(0);
  });

  it("keeps every region printable and apart on a crowded mountain", () => {
    // Deterministic scatter: five colors, twelve short runs each, crossing freely.
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const crowded: InlayGroup[] = ["lift", "black", "red", "blue", "green"].map((key) => ({
      key,
      paths: Array.from({ length: 12 }, () => {
        const x = random() * 3 - 1.5;
        const z = random() * 3 - 1.5;
        const a = random() * Math.PI * 2;
        return line([x, z], [x + Math.cos(a) * 1.2, z + Math.sin(a) * 1.2], 1.2 + random());
      }),
    }));
    const plans = planColors(m, footprint, { groups: crowded });
    expect(plans.length).toBeGreaterThan(3);
    for (const { section } of plans) {
      const regions = section.decompose();
      for (const region of regions) {
        expect(region.area()).toBeGreaterThan(0.99 * MM * MM);
        region.delete();
      }
    }
    for (let a = 0; a < plans.length; a++) {
      for (let b = a + 1; b < plans.length; b++) {
        const both = plans[a].section.intersect(plans[b].section);
        expect(both.area()).toBeLessThan(CLIPPING_NOISE_IN2);
        both.delete();
      }
    }
    freePlans(plans);
  });

  it("drops a color too narrow to print", () => {
    const plans = planColors(m, footprint, {
      groups: [
        { key: "black", paths: [line([-2, 0], [2, 0], 0.5)] },
        { key: "blue", paths: [line([-2, 1], [2, 1], 1.2)] },
      ],
    });
    expect(plans.map((p) => p.key)).toEqual(["blue"]);
    freePlans(plans);
  });

  it("leaves no color region narrower than two nozzle lines", () => {
    const plans = planColors(m, footprint, { groups: resort });
    for (const { section } of plans) {
      expect(thinArea(section, 0.7 * MM) / section.area()).toBeLessThan(0.01);
    }
    freePlans(plans);
  });

  it("closes a white gap too thin to print between two colors", () => {
    const gapMm = 0.25;
    const groups: InlayGroup[] = [
      { key: "black", paths: [line([-2, 0], [2, 0], 1.2)] },
      { key: "blue", paths: [line([-2, (1.2 + gapMm) * MM], [2, (1.2 + gapMm) * MM], 1.2)] },
    ];
    const plans = planColors(m, footprint, { groups });
    const merged = m.CrossSection.union(plans.map((p) => p.section));
    // One piece, and the gap's area has gone to a color.
    const pieces = merged.decompose();
    expect(pieces).toHaveLength(1);
    expect(merged.area()).toBeGreaterThan(4 * (2 * 1.2 + gapMm) * MM * 0.99);
    for (const piece of pieces) piece.delete();
    merged.delete();
    freePlans(plans);
  });

  it("keeps a white gap wide enough to print", () => {
    const groups: InlayGroup[] = [
      { key: "black", paths: [line([-2, 0], [2, 0], 1.2)] },
      { key: "blue", paths: [line([-2, 2.2 * MM], [2, 2.2 * MM], 1.2)] },
    ];
    const plans = planColors(m, footprint, { groups });
    const merged = m.CrossSection.union(plans.map((p) => p.section));
    const pieces = merged.decompose();
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) piece.delete();
    merged.delete();
    freePlans(plans);
  });
});

describe("inlayTerrain", () => {
  it("splits the terrain into bodies that add back up to it and never overlap", () => {
    const terrain = hillTerrain();
    const { terrain: white, inlays } = inlayTerrain(m, terrain, footprint, { groups: resort });
    expect(white.status()).toBe("NoError");
    expect(inlays.map((i) => i.key)).toEqual(["lift", "black", "blue", "green"]);

    let total = white.volume();
    for (const { solid } of inlays) {
      expect(solid.status()).toBe("NoError");
      expect(solid.volume()).toBeGreaterThan(0);
      total += solid.volume();
      const shared = m.Manifold.intersection(white, solid);
      expect(Math.abs(shared.volume())).toBeLessThan(1e-7);
      shared.delete();
    }
    expect(total).toBeCloseTo(terrain.volume(), 5);

    for (let a = 0; a < inlays.length; a++) {
      for (let b = a + 1; b < inlays.length; b++) {
        const shared = m.Manifold.intersection(inlays[a].solid, inlays[b].solid);
        expect(Math.abs(shared.volume())).toBeLessThan(1e-7);
        shared.delete();
      }
    }
    free([terrain, white, ...inlays.map((i) => i.solid)]);
  });

  it("leaves the white body in one piece with no sealed voids", () => {
    const terrain = hillTerrain();
    const { terrain: white, inlays } = inlayTerrain(m, terrain, footprint, { groups: resort });
    const shells = white.decompose();
    expect(shells).toHaveLength(1);
    expect(white.genus()).toBe(0);
    free([terrain, white, ...shells, ...inlays.map((i) => i.solid)]);
  });

  it("makes one solid piece per color region, with no fins or specks", () => {
    const terrain = hillTerrain();
    const plans = planColors(m, footprint, { groups: resort });
    const { terrain: white, inlays } = inlayTerrain(m, terrain, footprint, { groups: resort });
    inlays.forEach(({ solid }, i) => {
      const regions = plans[i].section.decompose();
      const pieces = solid.decompose();
      expect(pieces).toHaveLength(regions.length);
      for (const piece of pieces) expect(piece.volume()).toBeGreaterThan(MM ** 3);
      for (const region of regions) region.delete();
      free(pieces);
    });
    freePlans(plans);
    free([terrain, white, ...inlays.map((i) => i.solid)]);
  });

  it("makes every color flush with the surface and one inlay depth thick", () => {
    const terrain = hillTerrain();
    const plans = planColors(m, footprint, { groups: resort });
    const { terrain: white, inlays } = inlayTerrain(m, terrain, footprint, { groups: resort });
    inlays.forEach(({ solid }, i) => {
      // A pocket follows the surface straight down, so its volume is plan area times depth.
      expect(solid.volume()).toBeCloseTo(plans[i].section.area() * INLAY_DEPTH_IN, 5);
      expect(solid.boundingBox().max[1]).toBeLessThanOrEqual(terrain.boundingBox().max[1] + 1e-6);
      expect(solid.boundingBox().min[1]).toBeGreaterThan(BASE_IN - INLAY_DEPTH_IN - 1e-6);
    });
    // Nothing sticks out of or sinks into the original surface.
    const whole = m.Manifold.union([white, ...inlays.map((i) => i.solid)]);
    const extra = m.Manifold.difference(whole, terrain);
    const missing = m.Manifold.difference(terrain, whole);
    expect(Math.abs(extra.volume())).toBeLessThan(1e-7);
    expect(Math.abs(missing.volume())).toBeLessThan(1e-7);
    freePlans(plans);
    free([terrain, white, whole, extra, missing, ...inlays.map((i) => i.solid)]);
  });

  it("returns the terrain untouched when nothing is printable", () => {
    const terrain = hillTerrain();
    const { terrain: white, inlays } = inlayTerrain(m, terrain, footprint, {
      groups: [{ key: "black", paths: [line([-2, 0], [2, 0], 0.4)] }],
    });
    expect(inlays).toHaveLength(0);
    expect(white.volume()).toBeCloseTo(terrain.volume(), 8);
    free([terrain, white]);
  });
});

describe("buildModelSolids with inlays", () => {
  it("returns the color bodies beside a pocketed terrain", () => {
    const built = buildModelSolids(m, font, hillMesh(), {
      shape: "rectangle",
      widthInches: SIZE_IN,
      heightInches: SIZE_IN,
      rotation: 0,
      label: "Test Peak",
      plinth: true,
      brand: true,
      inlays: { groups: resort },
    });
    expect(built.grooveInlays.map((i) => i.key)).toEqual(["lift", "black", "blue", "green"]);
    const plain = hillTerrain();
    expect(built.terrain.volume()).toBeLessThan(plain.volume());
    expect(built.terrain.status()).toBe("NoError");
    free([plain, built.terrain, ...built.inlays, ...built.grooveInlays.map((i) => i.solid)]);
    built.plinth?.delete();
  });

  it("cuts the colors to a resort outline", () => {
    const outline = shapeOutline("circle", 4, 4, 0);
    const built = buildModelSolids(m, font, hillMesh(), {
      shape: "rectangle",
      widthInches: SIZE_IN,
      heightInches: SIZE_IN,
      rotation: 0,
      label: "",
      plinth: false,
      brand: false,
      outline,
      inlays: { groups: resort },
    });
    // The green run lies outside the circle; the rest stop inside it.
    expect(built.grooveInlays.map((i) => i.key)).toEqual(["lift", "black", "blue"]);
    for (const { solid } of built.grooveInlays) {
      const box = solid.boundingBox();
      expect(Math.max(-box.min[0], box.max[0], -box.min[2], box.max[2])).toBeLessThan(2 - 0.79 * MM);
    }
    free([built.terrain, ...built.grooveInlays.map((i) => i.solid)]);
  });
});
