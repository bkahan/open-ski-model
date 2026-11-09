// Compass rose for the name plate: a four-point star ringed by N, E, S
// and W. The whole figure fits a circle of the given diameter whichever
// way it is turned. The letters ride around with the star but stay
// upright, because a sideways N reads as a Z.
//
//          N
//          ▲
//     W ◄──┼──► E
//          ▼
//          S

import type { ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { fontSizeForCapHeight, textContours, type Contour } from "./text";

const CARDINALS = [
  { letter: "N", offsetDeg: 0 },
  { letter: "E", offsetDeg: -90 },
  { letter: "S", offsetDeg: 180 },
  { letter: "W", offsetDeg: 90 },
] as const;

const LETTER_CAP_FRACTION = 0.19;
/** Added around each stroke: Roboto Regular this small has stems thinner than a nozzle. */
const LETTER_BOLD_FRACTION = 0.01;
const STAR_GAP_FRACTION = 0.025;
const STAR_WAIST = 0.3;

interface HalfSize {
  halfWidth: number;
  halfHeight: number;
}

function fattenedContours(m: ManifoldToplevel, outlines: Contour[], bold: number): Contour[] {
  const section = new m.CrossSection(outlines, "NonZero");
  try {
    const fattened = section.offset(bold, "Miter", 2);
    try {
      return fattened.toPolygons() as Contour[];
    } finally {
      fattened.delete();
    }
  } finally {
    section.delete();
  }
}

function boldCenteredLetter(
  m: ManifoldToplevel,
  font: opentype.Font,
  letter: string,
  capHeight: number,
  bold: number,
): { contours: Contour[] } & HalfSize {
  const size = fontSizeForCapHeight(font, capHeight);
  const contours = fattenedContours(m, textContours(font, letter, size), bold);

  const xs = contours.flat().map(([x]) => x);
  const ys = contours.flat().map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    contours: contours.map((c) => c.map(([x, y]) => [x - cx, y - cy])),
    halfWidth: (maxX - minX) / 2,
    halfHeight: (maxY - minY) / 2,
  };
}

/** How far along a unit ray a box can sit with its farthest corner on the circle. */
function reachOnRay(dx: number, dy: number, box: HalfSize, radius: number): number {
  const b = Math.abs(dx) * box.halfWidth + Math.abs(dy) * box.halfHeight;
  const c = box.halfWidth ** 2 + box.halfHeight ** 2 - radius ** 2;
  return -b + Math.sqrt(b * b - c);
}

/** Distance along the ray at which it first enters the box centered at `reach`. */
function entryOnRay(dx: number, dy: number, box: HalfSize, reach: number): number {
  const entries = [
    dx === 0 ? -Infinity : reach - box.halfWidth / Math.abs(dx),
    dy === 0 ? -Infinity : reach - box.halfHeight / Math.abs(dy),
  ];
  return Math.max(...entries);
}

function starContour(radius: number, turnDeg: number): Contour {
  const waist = STAR_WAIST * radius;
  const points: Contour = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? radius : waist;
    const a = ((turnDeg + i * 45) * Math.PI) / 180;
    points.push([-r * Math.sin(a), r * Math.cos(a)]);
  }
  return points;
}

/**
 * Rose outlines centered on the origin. `turnDeg` is counter-clockwise
 * from north pointing +y.
 */
export function compassRoseContours(
  m: ManifoldToplevel,
  font: opentype.Font,
  diameter: number,
  turnDeg: number,
): Contour[] {
  const outerRadius = diameter / 2;
  const capHeight = LETTER_CAP_FRACTION * diameter;
  const bold = LETTER_BOLD_FRACTION * diameter;

  const contours: Contour[] = [];
  let starRadius = outerRadius;
  for (const { letter, offsetDeg } of CARDINALS) {
    const a = ((turnDeg + offsetDeg) * Math.PI) / 180;
    const dx = Math.abs(Math.sin(a)) < 1e-9 ? 0 : -Math.sin(a);
    const dy = Math.abs(Math.cos(a)) < 1e-9 ? 0 : Math.cos(a);
    const glyph = boldCenteredLetter(m, font, letter, capHeight, bold);
    const reach = reachOnRay(dx, dy, glyph, outerRadius);
    starRadius = Math.min(starRadius, entryOnRay(dx, dy, glyph, reach));
    for (const c of glyph.contours) {
      contours.push(c.map(([x, y]) => [x + dx * reach, y + dy * reach]));
    }
  }
  contours.push(starContour(starRadius - STAR_GAP_FRACTION * diameter, turnDeg));
  return contours;
}
