// Text a 0.4 mm nozzle can print. A font's outlines are drawn for ink:
// set small, their strokes are thinner than one pass of the nozzle and
// some pairs of letters sit closer than the nozzle can lay plate between.
// So every line of plate text is laid out here: strokes are thickened to
// two passes, the letters are spread by what the thickening took from the
// spaces between them, and any letter still too close to one before it
// is moved along.
//
// Thickening also narrows the openings inside letters, and that sets how
// small text may go. Lower case has the tight ones (the mouths of a, e, g
// and s, the dots on i and j), so it stops at a larger size than capitals.

import type { ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import {
  fontSizeForCapHeight,
  layoutGlyphs,
  measureTextWidth,
  textContours,
  type Contour,
  type PlacedGlyph,
} from "./text";

const MM_PER_INCH = 25.4;
const NOZZLE_MM = 0.4;
/** Two passes of the nozzle: the thinnest stroke that prints as a clean line of color. */
export const MIN_STROKE_IN = (2 * NOZZLE_MM) / MM_PER_INCH;
/** One pass with a little to spare: the least plate left between or inside letters. */
export const MIN_GAP_IN = 0.5 / MM_PER_INCH;
/** Smallest cap height at which thickened lower case keeps every opening that wide. */
export const MIN_TEXT_CAP_IN = 6 / MM_PER_INCH;
/** The same for a line set all in capitals, whose openings are larger. */
export const MIN_CAPITALS_CAP_IN = 4.4 / MM_PER_INCH;

/** Arc steps for the thickening's rounded corners, which are smaller than the nozzle. */
const THICKEN_ARC_SEGMENTS = 16;
/** A pair pushed apart along the line gains less than the push when it meets on a diagonal. */
const MAX_SPREAD_PASSES = 12;
const SPREAD_TOLERANCE_IN = 1e-5;

/** Thinnest straight stroke of each font, in cap heights. */
const thinStrokeByFont = new WeakMap<opentype.Font, number>();

function distinctHeights(contours: Contour[]): number[] {
  const heights = contours.flat().map(([, y]) => y);
  return [...new Set(heights.map((y) => Math.round(y * 1e4) / 1e4))].sort((a, b) => a - b);
}

/**
 * Read off the font itself: the stem of "l" and the bar of "T", whichever
 * is thinner. In a sans the bars are the thin strokes.
 */
function thinStroke(font: opentype.Font): number {
  const known = thinStrokeByFont.get(font);
  if (known !== undefined) return known;
  const unit = fontSizeForCapHeight(font, 1);
  const stemXs = textContours(font, "l", unit).flat().map(([x]) => x);
  const stem = stemXs.length > 0 ? Math.max(...stemXs) - Math.min(...stemXs) : 0;
  const barHeights = distinctHeights(textContours(font, "T", unit));
  const bar = barHeights.length >= 2 ? barHeights[barHeights.length - 1] - barHeights[barHeights.length - 2] : 0;
  const measured = [stem, bar].filter((width) => width > 0.02 && width < 0.4);
  // A font these glyphs can't be read from is treated as a typical regular weight.
  const thin = measured.length > 0 ? Math.min(...measured) : 0.11;
  thinStrokeByFont.set(font, thin);
  return thin;
}

/** How far each outline has to move outward for the thin strokes to reach two passes. */
export function strokeGrowth(font: opentype.Font, capHeight: number): number {
  return Math.max(0, (MIN_STROKE_IN - thinStroke(font) * capHeight) / 2);
}

function pointToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function pointsToOutlines(points: Contour[], outlines: Contour[]): number {
  let nearest = Infinity;
  for (const ring of points) {
    for (const point of ring) {
      for (const outline of outlines) {
        for (let i = 0; i < outline.length; i++) {
          nearest = Math.min(nearest, pointToSegment(point, outline[i], outline[(i + 1) % outline.length]));
        }
      }
    }
  }
  return nearest;
}

/**
 * Least distance between two sets of outlines that don't cross. Outlines
 * that do cross, or sit one inside the other, are not detected: glyphs of
 * one line never do. Infinity when either set is empty.
 */
export function gapBetween(a: Contour[], b: Contour[]): number {
  return Math.min(pointsToOutlines(a, b), pointsToOutlines(b, a));
}

function extentX(contours: Contour[]): [number, number] {
  const xs = contours.flat().map(([x]) => x);
  return [Math.min(...xs), Math.max(...xs)];
}

function shifted(contours: Contour[], dx: number): Contour[] {
  return contours.map((ring) => ring.map(([x, y]): [number, number] => [x + dx, y]));
}

export interface PrintableLine {
  /** Glyph outlines as the font draws them, at their spread positions. */
  glyphs: PlacedGlyph[];
  /** What thickenedContours adds around every outline. */
  grow: number;
  width: number;
  /** How far the thickened line reaches below its baseline: a comma, a descender. */
  depth: number;
}

interface SetGlyph {
  contours: Contour[];
  right: number;
}

/**
 * How much farther along the line `contours` must sit to leave `leastGap`
 * to everything already set. Usually only the letter before matters, but
 * a narrow mark can leave its neighbors facing each other, as in L'A.
 */
function spreadToClear(contours: Contour[], set: SetGlyph[], spread: number, leastGap: number): number {
  let needed = spread;
  for (let pass = 0; pass < MAX_SPREAD_PASSES; pass++) {
    const moved = shifted(contours, needed);
    const left = extentX(moved)[0];
    let short = 0;
    for (const earlier of set) {
      // Clear along the line is clear in every direction: skip the exact measure.
      if (left - earlier.right >= leastGap) continue;
      short = Math.max(short, leastGap - gapBetween(earlier.contours, moved));
    }
    if (short <= SPREAD_TOLERANCE_IN) break;
    needed += short;
  }
  return needed;
}

/**
 * A line of text at a cap height, spaced for printing: once thickened by
 * `grow`, neighbors have the gap the font gave them, and no two letters
 * are closer than MIN_GAP_IN.
 */
export function layoutPrintableLine(font: opentype.Font, text: string, capHeight: number): PrintableLine {
  const size = fontSizeForCapHeight(font, capHeight);
  const grow = strokeGrowth(font, capHeight);
  // Measured between the outlines as drawn, before thickening closes in on both sides.
  const leastGap = MIN_GAP_IN + 2 * grow;

  const glyphs: PlacedGlyph[] = [];
  const set: SetGlyph[] = [];
  let spread = 0;
  let lowest = 0;
  for (const glyph of layoutGlyphs(font, text, size)) {
    if (set.length > 0) spread = spreadToClear(glyph.contours, set, spread + 2 * grow, leastGap);
    const contours = shifted(glyph.contours, spread);
    glyphs.push({ contours, centerX: glyph.centerX + spread, advance: glyph.advance });
    set.push({ contours, right: extentX(contours)[1] });
    for (const ring of contours) for (const [, y] of ring) lowest = Math.min(lowest, y);
  }
  return {
    glyphs,
    grow,
    width: measureTextWidth(font, text, size) + spread,
    depth: glyphs.length > 0 ? grow - lowest : 0,
  };
}

/**
 * Outlines moved outward by `grow` all round, corners rounded. With
 * nothing to add the outlines come back as they are, not copied.
 */
export function thickenedContours(m: ManifoldToplevel, outlines: Contour[], grow: number): Contour[] {
  if (grow <= 0 || outlines.length === 0) return outlines;
  const section = new m.CrossSection(outlines, "NonZero");
  try {
    const thickened = section.offset(grow, "Round", 2, THICKEN_ARC_SEGMENTS);
    try {
      return thickened.toPolygons();
    } finally {
      thickened.delete();
    }
  } finally {
    section.delete();
  }
}
