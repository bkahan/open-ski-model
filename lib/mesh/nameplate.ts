// Name plate: the place name and a compass rose set into one chamfer of
// the plinth, the one on the resort's base side when that is known and
// otherwise the bottom edge of the frame. Each glyph is placed on its
// own, so on a circular plinth the text follows the cone instead of
// cutting a flat chord through it.
//
// Frames, all in inches:
//   text space      x right, y up, extruded +z (what text.ts produces)
//   face space      the south chamfer of the unrotated shape: x along
//                   the face, "up" is up the slope toward the terrain,
//                   normal tilted 35° off vertical toward a viewer
//                   standing south
//   model space     x east, y up, z north. One spin about y takes the
//                   face to where it belongs: around the cone (circle),
//                   to the chosen face, then the model's own rotation,
//                   all with shapeOutline's sign convention
//
// Font size comes from the chamfer: cap height is a fraction of the
// slope length, clamped to what a nozzle can resolve, then shrunk until
// the name and rose fit the face. A name that still won't fit loses its
// generic words before it loses letters.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { normalizeDeg } from "@/lib/angle";
import type { Shape } from "@/lib/shape";

import { compassRoseContours } from "./compass";
import { extrudeContours } from "./manifold";
import {
  BEVEL_DEG,
  chamferSlopeInches,
  plinthHeightInches,
  RIM_IN,
} from "./plinth";
import {
  fontSizeForCapHeight,
  layoutGlyphs,
  measureTextWidth,
  type Contour,
} from "./text";

const MM_PER_INCH = 25.4;

/** Cap height as a fraction of the chamfer slope length. */
const CAP_FRACTION = 0.38;
const MIN_CAP_IN = 3 / MM_PER_INCH;
const MAX_CAP_IN = 9 / MM_PER_INCH;
/** Pocket depth and how far the cutter starts above the face. */
export const POCKET_DEPTH_IN = 1 / MM_PER_INCH;
export const OVERCUT_IN = 0.02;
/** Gaps: face ends to content, and between name and rose, in caps. */
export const END_MARGIN_CAPS = 0.8;
export const ROSE_GAP_CAPS = 0.6;
/** Keeps the rose's pocket from breaking through the plinth's underside. */
const ROSE_BOTTOM_EXTRA_IN = 0.3 / MM_PER_INCH;
const ROSE_TOP_CLEAR_IN = 0.5 / MM_PER_INCH;
/** On a circle, how much of the cone the plate may wrap around. */
const MAX_ARC_DEG = 110;

export interface PlateSide {
  shape: Shape;
  widthInches: number;
  heightInches: number;
  rotation: number;
  /**
   * Geographic bearing the plate should face, degrees clockwise from
   * north; snapped to the nearest face on rectangles and hexagons.
   * Omitted: the bottom edge of the frame, whatever the rotation.
   */
  facing?: number;
}

export interface NameplateSpec extends PlateSide {
  label: string;
  compass: boolean;
  rimInches?: number;
}

export interface NameplateLayout {
  capInches: number;
  /** The text actually set (may be shortened to fit). */
  text: string;
  compass: boolean;
}

interface Face {
  /** Distance from model center to the top edge of the face. */
  topRadius: number;
  /** Usable length along the face (chord for flat faces, arc for the cone). */
  usable: number;
  curved: boolean;
  /** Spin about y, in shapeOutline's degrees, from the unrotated south face to this one. */
  turn: number;
  /** Extra spin that puts the rose on its own face; omitted when it shares this one. */
  roseFaceTurn?: number;
}

/**
 * How far the unrotated south face must spin to end up facing `facing`
 * once the model's own rotation is applied. A face spun by t sits at
 * bearing 180 − (t + rotation), so t = 180 − facing − rotation.
 */
function wantedTurn(side: PlateSide): number {
  if (side.facing === undefined || !Number.isFinite(side.facing)) return 0;
  return normalizeDeg(180 - side.facing - side.rotation);
}

function snapTurn(turn: number, stepDeg: number): number {
  return normalizeDeg(Math.round(turn / stepDeg) * stepDeg);
}

/** The spin that takes the south face to the plate's face, for anything else that should line up with it. */
export function plateTurnDeg(side: PlateSide): number {
  switch (side.shape) {
    case "rectangle":
      return snapTurn(wantedTurn(side), 90);
    case "hexagon":
      return snapTurn(wantedTurn(side), 60);
    case "circle":
      return snapTurn(wantedTurn(side), 1);
  }
}

/**
 * The bearing the plate ends up facing once snapped to a face (or to a
 * whole degree on a circle). Feeding this back in as `facing` gives the
 * same plate, which makes it a stable key for rebuilds.
 */
export function plateFacingDeg(side: PlateSide): number {
  return normalizeDeg(180 - plateTurnDeg(side) - side.rotation);
}

function plateFace(spec: NameplateSpec, rim: number): Face {
  const { shape, widthInches, heightInches } = spec;
  const turn = plateTurnDeg(spec);
  switch (shape) {
    case "rectangle": {
      // South and north faces run the width; east and west the height.
      const alongWidth = turn % 180 === 0;
      return {
        topRadius: (alongWidth ? heightInches : widthInches) / 2,
        usable: alongWidth ? widthInches : heightInches,
        curved: false,
        turn,
      };
    }
    case "hexagon":
      // Flat-top hexagon: every side is R = W/2 long, H/2 from center.
      // That is too short to share, so the rose takes the next face to
      // the reader's right and the name keeps this one.
      return {
        topRadius: heightInches / 2,
        usable: widthInches / 2,
        curved: false,
        turn,
        roseFaceTurn: 60,
      };
    case "circle": {
      const midRadius = widthInches / 2 + rim / 2;
      return {
        topRadius: widthInches / 2,
        usable: midRadius * ((MAX_ARC_DEG * Math.PI) / 180),
        curved: true,
        turn,
      };
    }
  }
}

/** Slope distance the rose must stay above the chamfer's bottom edge. */
function roseBottomClearInches(): number {
  return POCKET_DEPTH_IN / Math.tan((BEVEL_DEG * Math.PI) / 180) + ROSE_BOTTOM_EXTRA_IN;
}

/** The rose is as big as the chamfer allows, whatever the model size. */
export function roseDiameterInches(rimInches = RIM_IN): number {
  return chamferSlopeInches(rimInches) - roseBottomClearInches() - ROSE_TOP_CLEAR_IN;
}

/** The label, then progressively plainer forms of it, longest first. */
function nameForms(label: string): string[] {
  const beforeComma = label.split(",")[0].trim();
  const withoutGeneric = beforeComma.replace(/\s+(ski\s+)?(resort|area)$/i, "");
  return [...new Set([label, beforeComma, withoutGeneric])].filter(Boolean);
}

function shortenByOneLetter(text: string): string {
  const trimmed = text.replace(/…$/, "").slice(0, -1).trimEnd();
  return trimmed ? trimmed + "…" : "";
}

export interface PlateContent {
  label: string;
  compass: boolean;
  /** Length available along the face. */
  usable: number;
  /** Height of the face, which sets the largest cap height. */
  slope: number;
  roseDiameter: number;
  /** Whether the rose takes room on the same face as the name. */
  roseShares: boolean;
}

/** Pick the cap height and, if needed, a shorter name so the content fits. */
export function fitPlateContent(
  font: opentype.Font,
  content: PlateContent,
): NameplateLayout | null {
  const { label, usable, slope, roseDiameter } = content;
  const compass = content.compass && roseDiameter <= usable;
  if (!label && !compass) return null;
  const roseShares = compass && content.roseShares;

  const largestCap = Math.min(MAX_CAP_IN, Math.max(MIN_CAP_IN, CAP_FRACTION * slope));
  // Everything but the rose scales with the cap height, so the largest
  // cap that fits is solved for directly. Comparing widths after scaling
  // would let rounding error reject a name that fits exactly.
  const capFor = (text: string) => {
    const unitWidth =
      (text ? measureTextWidth(font, text, fontSizeForCapHeight(font, 1)) : 0) +
      (text && roseShares ? ROSE_GAP_CAPS : 0) +
      2 * END_MARGIN_CAPS;
    return Math.min(largestCap, (usable - (roseShares ? roseDiameter : 0)) / unitWidth);
  };

  const forms = nameForms(label);
  const fitting = forms.find((form) => capFor(form) >= MIN_CAP_IN);
  if (fitting) return { capInches: capFor(fitting), text: fitting, compass };

  let text = forms.at(-1) ?? "";
  while (text && capFor(text) < MIN_CAP_IN) text = shortenByOneLetter(text);
  if (!text && !compass) return null;
  return { capInches: text ? MIN_CAP_IN : largestCap, text, compass };
}

/** Fit the name and rose to the plinth face they will sit on. */
export function fitNameplate(
  font: opentype.Font,
  spec: NameplateSpec,
): NameplateLayout | null {
  const rim = spec.rimInches ?? RIM_IN;
  const face = plateFace(spec, rim);
  return fitPlateContent(font, {
    label: spec.label.trim(),
    compass: spec.compass,
    usable: face.usable,
    slope: chamferSlopeInches(rim),
    roseDiameter: roseDiameterInches(rim),
    roseShares: face.roseFaceTurn === undefined,
  });
}

/**
 * Pocket solids for the plate (one per glyph, plus the rose), in model
 * space and ready to be subtracted from the plinth. Returns [] when
 * nothing fits.
 */
export function buildNameplateSolids(
  m: ManifoldToplevel,
  font: opentype.Font,
  spec: NameplateSpec,
): { solids: Manifold[]; layout: NameplateLayout | null } {
  const layout = fitNameplate(font, spec);
  if (!layout) return { solids: [], layout: null };

  const rim = spec.rimInches ?? RIM_IN;
  const h = plinthHeightInches(rim);
  const face = plateFace(spec, rim);
  const midRadius = face.topRadius + rim / 2;
  const cap = layout.capInches;
  const fontSize = fontSizeForCapHeight(font, cap);

  // Content laid out along the face, centered on the face's middle.
  const textWidth = layout.text
    ? measureTextWidth(font, layout.text, fontSize)
    : 0;
  const roseDiameter = layout.compass ? roseDiameterInches(rim) : 0;
  const roseShares = layout.compass && face.roseFaceTurn === undefined;
  const gap = layout.text && roseShares ? ROSE_GAP_CAPS * cap : 0;
  const total = textWidth + gap + (roseShares ? roseDiameter : 0);
  const startX = -total / 2;

  // Text and the rose each have an x position along the face; glyph
  // contours are built around their own center, then placed.
  const items: Array<{ contours: Contour[]; x: number; extraTurn: number }> = [];
  if (layout.text) {
    for (const g of layoutGlyphs(font, layout.text, fontSize)) {
      items.push({
        contours: g.contours.map((c) =>
          c.map(([x, y]) => [x - g.centerX, y - cap / 2]),
        ),
        x: startX + g.centerX,
        extraTurn: 0,
      });
    }
  }
  if (layout.compass) {
    items.push(
      roseShares
        ? { contours: [], x: startX + textWidth + gap + roseDiameter / 2, extraTurn: 0 }
        : { contours: [], x: 0, extraTurn: face.roseFaceTurn ?? 0 },
    );
  }

  const depth = POCKET_DEPTH_IN + OVERCUT_IN;
  // Rotation about X that lays text-space "up" along the slope and
  // sends the extrusion into the face.
  const tilt = 90 - BEVEL_DEG;

  const solids: Manifold[] = [];
  try {
    for (const item of items) {
      // Along a cone the position is an angle; on a flat face it's an offset.
      const angleDeg = face.curved ? (item.x / midRadius) * (180 / Math.PI) : 0;
      const alongX = face.curved ? 0 : item.x;
      // Everything that turns the south face into this item's spot.
      const spin = angleDeg + face.turn + item.extraTurn + spec.rotation;

      let contours = item.contours;
      if (contours.length === 0) {
        // The rose: north at true north. In face space "up" is toward the
        // model center, which is north only before the spin, so the rose
        // is turned back by the same amount. It sits a little above the
        // middle of the slope because the bottom edge needs more room.
        const lift = (roseBottomClearInches() - ROSE_TOP_CLEAR_IN) / 2;
        contours = compassRoseContours(m, font, roseDiameter, -spin).map((c) =>
          c.map(([x, y]) => [x, y + lift]),
        );
      }

      const steps: Manifold[] = [];
      try {
        const flat = extrudeContours(m, contours, depth);
        steps.push(flat);
        const shifted = flat.translate([0, 0, -OVERCUT_IN]);
        steps.push(shifted);
        const tilted = shifted.rotate([tilt, 0, 0]);
        steps.push(tilted);
        const onFace = tilted.translate([alongX, h / 2, -midRadius]);
        steps.push(onFace);
        solids.push(onFace.rotate([0, -spin, 0]));
      } finally {
        for (const s of steps) s.delete();
      }
    }
  } catch (err) {
    for (const s of solids) s.delete();
    throw err;
  }
  return { solids, layout };
}
