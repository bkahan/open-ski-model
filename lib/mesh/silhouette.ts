// Cuts a model to the shape of the ski area instead of a geometric frame.
// The outline is every run and lift thickened until they merge, with the
// bays between them closed up. Under it sits a thin slab with a straight
// name tab on the resort's base side, since an irregular edge has no face
// long enough to carry text.
//
// Outlines are in the model plane: x east, z north, inches.

import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { normalizeDeg } from "@/lib/angle";

import { compassRoseContours } from "./compass";
import { extrudeContours } from "./manifold";
import {
  END_MARGIN_CAPS,
  fitPlateContent,
  OVERCUT_IN,
  POCKET_DEPTH_IN,
  ROSE_GAP_CAPS,
  type NameplateLayout,
} from "./nameplate";
import {
  fontSizeForCapHeight,
  layoutGlyphs,
  measureTextWidth,
  type Contour,
} from "./text";

const MM_PER_INCH = 25.4;

/** Fractions of the print's longest side, so the shape looks the same at any size. */
const BUFFER_FRACTION = 0.03;
const CLOSING_FRACTION = 0.07;
const LINE_HALF_WIDTH_IN = 0.005;
const SIMPLIFY_IN = 0.004;
const ARC_SEGMENTS = 48;

export const OUTLINE_PLINTH_HEIGHT_IN = 4 / MM_PER_INCH;
const SLAB_RIM_IN = 5 / MM_PER_INCH;
const TAB_ROSE_DIAMETER_IN = 18 / MM_PER_INCH;
const TAB_CLEAR_IN = 2 / MM_PER_INCH;
const TAB_DEPTH_IN = TAB_ROSE_DIAMETER_IN + 2 * TAB_CLEAR_IN;
const TAB_GAP_IN = 2 / MM_PER_INCH;
const TAB_MIN_LENGTH_IN = 2.25;
const TAB_MIN_USABLE_IN = 2.5;
const SLAB_ROUNDING_IN = 3 / MM_PER_INCH;

function signedArea(ring: Contour): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

function segmentQuad(a: [number, number], b: [number, number], halfWidth: number): Contour {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return [
    [a[0] - nx, a[1] - ny],
    [b[0] - nx, b[1] - ny],
    [b[0] + nx, b[1] + ny],
    [a[0] + nx, a[1] + ny],
  ];
}

/** Runs each step on the last result, freeing every intermediate section. */
function pipeSections(
  start: CrossSection,
  steps: Array<(s: CrossSection) => CrossSection>,
): CrossSection {
  let current = start;
  try {
    for (const step of steps) {
      const next = step(current);
      current.delete();
      current = next;
    }
    return current;
  } catch (err) {
    current.delete();
    throw err;
  }
}

function largestOuterRing(section: CrossSection): Contour | null {
  let best: Contour | null = null;
  let bestArea = 0;
  for (const ring of section.toPolygons() as Contour[]) {
    const area = signedArea(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

/**
 * One closed ring around the lines, clipped to `frame`. A cluster detached
 * from the main body (usually the next resort over) is dropped, and so are
 * holes. Returns null when there is nothing to outline.
 */
export function buildResortOutline(
  m: ManifoldToplevel,
  lines: Array<Array<[number, number]>>,
  frame: Contour,
  printLongestInches: number,
): Contour | null {
  const quads: Contour[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (line[i][0] === line[i + 1][0] && line[i][1] === line[i + 1][1]) continue;
      quads.push(segmentQuad(line[i], line[i + 1], LINE_HALF_WIDTH_IN));
    }
  }
  if (quads.length === 0) return null;

  const buffer = BUFFER_FRACTION * printLongestInches;
  const closing = CLOSING_FRACTION * printLongestInches;
  const frameSection = new m.CrossSection([frame], "NonZero");
  try {
    const merged = pipeSections(new m.CrossSection(quads, "NonZero"), [
      (s) => s.offset(buffer + closing, "Round", 2, ARC_SEGMENTS),
      (s) => s.offset(-closing, "Round", 2, ARC_SEGMENTS),
      (s) => s.intersect(frameSection),
      (s) => s.simplify(SIMPLIFY_IN),
    ]);
    try {
      return largestOuterRing(merged);
    } finally {
      merged.delete();
    }
  } finally {
    frameSection.delete();
  }
}

/**
 * Point-in-outline test snapped to the elevation grid, filled by scanline.
 * Contour lines and run ribbons ask this for every cell and sample, which
 * would be too slow against the polygon itself.
 */
export function outlineMask(
  outline: Contour,
  gridWidthInches: number,
  gridHeightInches: number,
  columns: number,
  rows: number,
): (x: number, z: number) => boolean {
  const cells = new Uint8Array(columns * rows);
  const dx = gridWidthInches / (columns - 1);
  const dz = gridHeightInches / (rows - 1);
  for (let j = 0; j < rows; j++) {
    const z = gridHeightInches / 2 - j * dz;
    const crossings: number[] = [];
    for (let e = 0; e < outline.length; e++) {
      const [ax, az] = outline[e];
      const [bx, bz] = outline[(e + 1) % outline.length];
      if (az <= z !== bz <= z) crossings.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    crossings.sort((a, b) => a - b);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const first = Math.ceil((crossings[c] + gridWidthInches / 2) / dx);
      const last = Math.floor((crossings[c + 1] + gridWidthInches / 2) / dx);
      for (let i = Math.max(0, first); i <= Math.min(columns - 1, last); i++) {
        cells[j * columns + i] = 1;
      }
    }
  }
  return (x, z) => {
    const i = Math.round((x + gridWidthInches / 2) / dx);
    const j = Math.round((gridHeightInches / 2 - z) / dz);
    if (i < 0 || j < 0 || i >= columns || j >= rows) return false;
    return cells[j * columns + i] === 1;
  };
}

/** Extrude plane contours straight up from y = 0. */
function prismFromSection(section: CrossSection, height: number): Manifold {
  // A section's y becomes -z when stood up, so z is negated going in.
  const mirrored = section.scale([1, -1]);
  try {
    const extruded = mirrored.extrude(height);
    try {
      return extruded.rotate([-90, 0, 0]);
    } finally {
      extruded.delete();
    }
  } finally {
    mirrored.delete();
  }
}

export function outlinePrism(m: ManifoldToplevel, outline: Contour, height: number): Manifold {
  const section = new m.CrossSection([outline], "NonZero");
  try {
    return prismFromSection(section, height);
  } finally {
    section.delete();
  }
}

export interface OutlinePlinthSpec {
  outline: Contour;
  label: string;
  compass: boolean;
  /** Bearing the tab should sit on, degrees clockwise from north. Defaults to south. */
  facing?: number;
}

export interface OutlinePlinth {
  slab: Manifold;
  /** Pocket solids, one per glyph plus the rose. */
  solids: Manifold[];
  layout: NameplateLayout | null;
  /** Turn and unturned position for anything that should line up with the tab. */
  spin: number;
  tabCenter: [number, number];
}

interface TabPlacement {
  layout: NameplateLayout | null;
  length: number;
  centerX: number;
  /** Front edge of the outline, in the frame where the tab faces -z. */
  outlineFront: number;
  outlineBack: number;
}

function placeTab(
  font: opentype.Font,
  unturned: Contour,
  spec: OutlinePlinthSpec,
): TabPlacement {
  const xs = unturned.map(([x]) => x);
  const zs = unturned.map(([, z]) => z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const outlineFront = Math.min(...zs);
  const outlineBack = Math.max(...zs);

  const layout = fitPlateContent(font, {
    label: spec.label.trim(),
    compass: spec.compass,
    usable: Math.max(TAB_MIN_USABLE_IN, maxX - minX),
    slope: TAB_ROSE_DIAMETER_IN,
    roseDiameter: TAB_ROSE_DIAMETER_IN,
    roseShares: true,
  });
  const content = layout ? contentWidth(font, layout) : 0;
  const margin = layout ? 2 * END_MARGIN_CAPS * layout.capInches : 0;
  const length = Math.max(TAB_MIN_LENGTH_IN, content + margin);

  // Centered on the outline where possible, but always over its frontmost
  // point: that is what keeps the tab joined to the slab.
  const frontX = unturned[zs.indexOf(outlineFront)][0];
  const reach = length / 2 - SLAB_ROUNDING_IN;
  const centerX = Math.min(frontX + reach, Math.max(frontX - reach, (minX + maxX) / 2));
  return { layout, length, centerX, outlineFront, outlineBack };
}

function contentWidth(font: opentype.Font, layout: NameplateLayout): number {
  const text = layout.text
    ? measureTextWidth(font, layout.text, fontSizeForCapHeight(font, layout.capInches))
    : 0;
  const rose = layout.compass ? TAB_ROSE_DIAMETER_IN : 0;
  const gap = layout.text && layout.compass ? ROSE_GAP_CAPS * layout.capInches : 0;
  return text + gap + rose;
}

function turnedBy(points: Contour, degrees: number): Contour {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return points.map(([x, z]) => [x * c + z * s, -x * s + z * c]);
}

function slabFootprint(
  m: ManifoldToplevel,
  outline: Contour,
  tab: Contour,
): CrossSection {
  const body = new m.CrossSection([outline], "NonZero");
  const tabSection = new m.CrossSection([tab], "NonZero");
  try {
    return pipeSections(body.offset(SLAB_RIM_IN, "Round", 2, ARC_SEGMENTS), [
      (s) => s.add(tabSection),
      (s) => s.offset(SLAB_ROUNDING_IN, "Round", 2, ARC_SEGMENTS),
      (s) => s.offset(-2 * SLAB_ROUNDING_IN, "Round", 2, ARC_SEGMENTS),
      (s) => s.offset(SLAB_ROUNDING_IN, "Round", 2, ARC_SEGMENTS),
    ]);
  } finally {
    body.delete();
    tabSection.delete();
  }
}

/** One glyph or rose outline, cut straight down into the slab's top at (x, z). */
function flatPocket(
  m: ManifoldToplevel,
  contours: Contour[],
  x: number,
  z: number,
  spin: number,
): Manifold {
  const flat = extrudeContours(m, contours, POCKET_DEPTH_IN + OVERCUT_IN);
  const steps = [flat];
  try {
    const raised = flat.translate([0, 0, -OVERCUT_IN]);
    steps.push(raised);
    const laid = raised.rotate([90, 0, 0]);
    steps.push(laid);
    const placed = laid.translate([x, OUTLINE_PLINTH_HEIGHT_IN, z]);
    steps.push(placed);
    return placed.rotate([0, -spin, 0]);
  } finally {
    for (const s of steps) s.delete();
  }
}

export function buildOutlinePlinth(
  m: ManifoldToplevel,
  font: opentype.Font,
  spec: OutlinePlinthSpec,
): OutlinePlinth {
  const spin = normalizeDeg(180 - (spec.facing ?? 180));
  const unturned = turnedBy(spec.outline, spin);
  const tab = placeTab(font, unturned, spec);
  const { layout, length, centerX, outlineFront, outlineBack } = tab;

  const tabOuter = outlineFront - TAB_GAP_IN - TAB_DEPTH_IN;
  const tabInner = outlineFront + 0.25 * (outlineBack - outlineFront);
  const tabZ = tabOuter + TAB_DEPTH_IN / 2;
  const tabRing: Contour = turnedBy(
    [
      [centerX - length / 2, tabOuter],
      [centerX + length / 2, tabOuter],
      [centerX + length / 2, tabInner],
      [centerX - length / 2, tabInner],
    ],
    -spin,
  );

  const footprint = slabFootprint(m, spec.outline, tabRing);
  let slab: Manifold;
  try {
    slab = prismFromSection(footprint, OUTLINE_PLINTH_HEIGHT_IN);
  } finally {
    footprint.delete();
  }

  const solids: Manifold[] = [];
  try {
    if (layout) {
      const startX = centerX - contentWidth(font, layout) / 2;
      const cap = layout.capInches;
      let textEnd = startX;
      if (layout.text) {
        const size = fontSizeForCapHeight(font, cap);
        for (const glyph of layoutGlyphs(font, layout.text, size)) {
          const contours = glyph.contours.map((c) =>
            c.map(([x, y]): [number, number] => [x - glyph.centerX, y - cap / 2]),
          );
          solids.push(flatPocket(m, contours, startX + glyph.centerX, tabZ, spin));
        }
        textEnd = startX + measureTextWidth(font, layout.text, size) + ROSE_GAP_CAPS * cap;
      }
      if (layout.compass) {
        const rose = compassRoseContours(m, font, TAB_ROSE_DIAMETER_IN, -spin);
        solids.push(flatPocket(m, rose, textEnd + TAB_ROSE_DIAMETER_IN / 2, tabZ, spin));
      }
    }
  } catch (err) {
    slab.delete();
    for (const s of solids) s.delete();
    throw err;
  }
  return { slab, solids, layout, spin, tabCenter: [centerX, tabZ] };
}
