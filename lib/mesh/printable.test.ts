import { readFileSync } from "node:fs";
import { join } from "node:path";

import Module from "manifold-3d";
import * as opentype from "opentype.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fitNameplate, plateGlyphs } from "./nameplate";
import {
  gapBetween,
  layoutPrintableLine,
  MIN_CAPITALS_CAP_IN,
  MIN_GAP_IN,
  MIN_STROKE_IN,
  MIN_TEXT_CAP_IN,
  strokeGrowth,
  thickenedContours,
} from "./printable";
import { fontSizeForCapHeight, layoutGlyphs, measureTextWidth, textContours, type Contour } from "./text";

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

/** What is left of the outlines after `inset` is taken off every edge: [width, height], or null if nothing. */
function insetExtent(outlines: Contour[], inset: number): [number, number] | null {
  const section = new m.CrossSection(outlines, "NonZero");
  const eroded = section.offset(-inset, "Round", 2, 32);
  try {
    if (eroded.isEmpty()) return null;
    const { min, max } = eroded.bounds();
    return [max[0] - min[0], max[1] - min[1]];
  } finally {
    section.delete();
    eroded.delete();
  }
}

/**
 * Number of rings in the outlines once grown by `closeBy`. A hole that
 * fills in takes one away; an open mouth that closes adds one.
 */
function ringCount(outlines: Contour[], closeBy = 0): number {
  const section = new m.CrossSection(outlines, "NonZero");
  const closed = section.offset(closeBy, "Round", 2, 32);
  try {
    return closed.toPolygons().length;
  } finally {
    section.delete();
    closed.delete();
  }
}

describe("gapBetween", () => {
  const square = (x: number, y: number): Contour => [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
  ];

  it("measures side to side and corner to corner", () => {
    expect(gapBetween([square(0, 0)], [square(1.5, 0.2)])).toBeCloseTo(0.5, 9);
    expect(gapBetween([square(0, 0)], [square(4, 5)])).toBeCloseTo(5, 9);
  });

  it("finds a corner facing the middle of a long edge, from either side", () => {
    const wall: Contour = [
      [2, -10],
      [3, -10],
      [3, 10],
      [2, 10],
    ];
    expect(gapBetween([square(0, 0)], [wall])).toBeCloseTo(1, 9);
    expect(gapBetween([wall], [square(0, 0)])).toBeCloseTo(1, 9);
  });

  it("takes the nearest of several outlines and has nothing to measure to an empty set", () => {
    expect(gapBetween([square(0, 0), square(0, 3)], [square(0, 5.25)])).toBeCloseTo(1.25, 9);
    expect(gapBetween([square(0, 0)], [])).toBe(Infinity);
  });
});

describe("strokeGrowth", () => {
  it("thickens small letters until bar and stem both take two passes of the nozzle", () => {
    const cap = MIN_CAPITALS_CAP_IN;
    const drawn = textContours(font, "T", fontSizeForCapHeight(font, cap));
    const grow = strokeGrowth(font, cap);
    expect(grow).toBeGreaterThan(0.1 * MM);
    // A stroke survives an inset of just under half its width. As drawn,
    // neither the T's bar nor its stem is two passes wide.
    const inset = MIN_STROKE_IN / 2 - 0.01 * MM;
    expect(insetExtent(drawn, inset)).toBeNull();
    const left = insetExtent(thickenedContours(m, drawn, grow), inset);
    expect(left).not.toBeNull();
    const [width, height] = left ?? [0, 0];
    const xs = drawn.flat().map(([x]) => x);
    expect(width).toBeGreaterThan(0.7 * (Math.max(...xs) - Math.min(...xs)));
    expect(height).toBeGreaterThan(0.8 * cap);
  });

  it("leaves letters alone once they are big enough", () => {
    expect(strokeGrowth(font, 9 * MM)).toBe(0);
    const outlines = textContours(font, "T", 1);
    expect(thickenedContours(m, outlines, 0)).toEqual(outlines);
  });
});

describe("layoutPrintableLine", () => {
  const towns = [
    "Carrabassett Valley, ME",
    "Jay, VT",
    "Stowe, VT",
    "North Conway, NH",
    "Zermatt, Switzerland",
    "Waterville Valley, NH",
  ];
  const lines: Array<[string, number]> = [
    ...towns.map((town): [string, number] => [town, MIN_TEXT_CAP_IN]),
    ...towns.map((town): [string, number] => [town.toUpperCase(), MIN_CAPITALS_CAP_IN]),
    ["Jay Peak Resort", MIN_TEXT_CAP_IN],
    ["Loon Mountain Resort", MIN_TEXT_CAP_IN],
    ["L'Anse, MI", MIN_TEXT_CAP_IN],
    ["L'ANSE-ST-JEAN, QC", MIN_CAPITALS_CAP_IN],
    ["VAL-D'ISÈRE, FRANCE", MIN_CAPITALS_CAP_IN],
  ];

  it.each(lines)("leaves plate between every two thickened letters in %s", (text, cap) => {
    const { glyphs, grow } = layoutPrintableLine(font, text, cap);
    expect(glyphs).toHaveLength(text.replace(/\s/g, "").length);
    const thick = glyphs.map((glyph) => thickenedContours(m, glyph.contours, grow));
    for (let i = 0; i < thick.length; i++) {
      for (let j = i + 1; j < thick.length; j++) {
        expect(gapBetween(thick[i], thick[j]), `${i} to ${j}`).toBeGreaterThan(MIN_GAP_IN - 0.01 * MM);
      }
    }
  });

  it("moves a letter clear of the one before a narrow mark, not just of the mark", () => {
    // The apostrophe is too narrow to hold the A off the L's arm.
    const cap = MIN_TEXT_CAP_IN;
    const drawn = layoutGlyphs(font, "L'A", fontSizeForCapHeight(font, cap));
    expect(gapBetween(drawn[0].contours, drawn[2].contours)).toBeLessThan(MIN_GAP_IN);
    const { glyphs, grow } = layoutPrintableLine(font, "L'A", cap);
    const [l, , a] = glyphs.map((glyph) => thickenedContours(m, glyph.contours, grow));
    expect(gapBetween(l, a)).toBeGreaterThan(MIN_GAP_IN - 0.01 * MM);
  });

  it.each([
    ["tt", MIN_TEXT_CAP_IN],
    ["rt", MIN_TEXT_CAP_IN],
    ["ft", MIN_TEXT_CAP_IN],
    ["rv", MIN_TEXT_CAP_IN],
    ["VT", MIN_CAPITALS_CAP_IN],
  ])("opens %s, which the font sets closer than a nozzle pass", (pair, cap) => {
    const drawn = layoutGlyphs(font, pair, fontSizeForCapHeight(font, cap));
    expect(gapBetween(drawn[0].contours, drawn[1].contours)).toBeLessThan(MIN_GAP_IN);
    const { glyphs, grow } = layoutPrintableLine(font, pair, cap);
    const [left, right] = glyphs.map((glyph) => thickenedContours(m, glyph.contours, grow));
    const gap = gapBetween(left, right);
    expect(gap).toBeGreaterThan(MIN_GAP_IN - 0.01 * MM);
    // Moved only as far as needed.
    expect(gap).toBeLessThan(MIN_GAP_IN + 0.03 * MM);
  });

  it("gives back to roomy pairs the space the thickening took", () => {
    const size = fontSizeForCapHeight(font, MIN_TEXT_CAP_IN);
    const drawn = layoutGlyphs(font, "no", size);
    const natural = gapBetween(drawn[0].contours, drawn[1].contours);
    expect(natural).toBeGreaterThan(MIN_GAP_IN);
    const { glyphs, grow, width } = layoutPrintableLine(font, "no", MIN_TEXT_CAP_IN);
    expect(grow).toBeGreaterThan(0);
    const [left, right] = glyphs.map((glyph) => thickenedContours(m, glyph.contours, grow));
    expect(gapBetween(left, right)).toBeCloseTo(natural, 3);
    expect(width).toBeCloseTo(measureTextWidth(font, "no", size) + 2 * grow, 9);
  });

  it("sets big letters exactly as the font spaces them", () => {
    const cap = 12 * MM;
    const size = fontSizeForCapHeight(font, cap);
    const drawn = layoutGlyphs(font, "Mont Blanc", size);
    for (let i = 0; i + 1 < drawn.length; i++) {
      expect(gapBetween(drawn[i].contours, drawn[i + 1].contours)).toBeGreaterThan(MIN_GAP_IN);
    }
    const line = layoutPrintableLine(font, "Mont Blanc", cap);
    expect(line.grow).toBe(0);
    expect(line.width).toBeCloseTo(measureTextWidth(font, "Mont Blanc", size), 9);
    expect(line.glyphs.map((glyph) => glyph.centerX)).toEqual(drawn.map((glyph) => glyph.centerX));
  });

  it("reports how far a comma or descender hangs below the baseline", () => {
    const flat = layoutPrintableLine(font, "STOWE", MIN_CAPITALS_CAP_IN);
    const comma = layoutPrintableLine(font, "STOWE, VT", MIN_CAPITALS_CAP_IN);
    const tail = layoutPrintableLine(font, "gypsy", MIN_TEXT_CAP_IN);
    // Round capitals dip a hair under the line; only the thickening shows.
    expect(flat.depth).toBeLessThan(flat.grow + 0.1 * MM);
    expect(comma.depth).toBeGreaterThan(flat.depth + 0.3 * MM);
    expect(Math.abs(tail.depth - (0.3 * MIN_TEXT_CAP_IN + tail.grow))).toBeLessThan(0.02 * MM);
    expect(layoutPrintableLine(font, "", MIN_TEXT_CAP_IN).depth).toBe(0);
  });

  it.each([
    ["lower case and everything else", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&", MIN_TEXT_CAP_IN],
    ["capitals, figures and marks", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&,.-'", MIN_CAPITALS_CAP_IN],
  ])("keeps every opening in %s wide enough to print at its smallest size", (_what, letters, cap) => {
    const size = fontSizeForCapHeight(font, cap);
    const grow = strokeGrowth(font, cap);
    for (const letter of letters) {
      const drawn = textContours(font, letter, size);
      const thick = thickenedContours(m, drawn, grow);
      // An opening narrower than the gap closes into a hole, or a hole fills in.
      expect(ringCount(thick, MIN_GAP_IN / 2), letter).toBe(ringCount(drawn));
    }
  });

  it("is why lower case stops at a larger size than capitals", () => {
    const size = fontSizeForCapHeight(font, MIN_CAPITALS_CAP_IN);
    const grow = strokeGrowth(font, MIN_CAPITALS_CAP_IN);
    const closes = [..."aes"].filter((letter) => {
      const drawn = textContours(font, letter, size);
      return ringCount(thickenedContours(m, drawn, grow), MIN_GAP_IN / 2) !== ringCount(drawn);
    });
    expect(closes).toEqual([..."aes"]);
  });
});

describe("two lines on the plate", () => {
  const NAME = "gypsy";

  it("keeps a descender on the name clear of the capitals under it", () => {
    const layout = fitNameplate(font, {
      shape: "rectangle",
      widthInches: 6,
      heightInches: 6,
      rotation: 0,
      label: NAME,
      place: "OCQSJ",
      compass: true,
    });
    expect(layout?.text).toBe(NAME);
    expect(layout?.place).toBe("OCQSJ");
    if (!layout) return;
    const placed = plateGlyphs(font, layout).map((glyph) =>
      thickenedContours(m, glyph.contours, glyph.grow).map((ring) =>
        ring.map(([x, y]): [number, number] => [x + glyph.centerX, y]),
      ),
    );
    const name = placed.slice(0, NAME.length);
    const place = placed.slice(NAME.length);
    expect(place).toHaveLength(5);
    const nearest = Math.min(...name.flatMap((upper) => place.map((lower) => gapBetween(upper, lower))));
    expect(nearest).toBeGreaterThan(MIN_GAP_IN);
    // The lines are set close: tails do come within a millimeter of the capitals.
    expect(nearest).toBeLessThan(1 * MM);
  });
});
