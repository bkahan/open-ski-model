// Name plate: the place name and a north arrow set into one chamfer of
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
// the name and arrow fit the face.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { normalizeDeg } from "@/lib/angle";
import type { Shape } from "@/lib/shape";

import { compassContour, rotateContour } from "./compass";
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
const OVERCUT_IN = 0.02;
/** Gaps: face ends to content, and between name and arrow, in caps. */
const END_MARGIN_CAPS = 0.8;
const ARROW_GAP_CAPS = 0.6;
const ARROW_SIZE_CAPS = 1.25;
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
      return {
        topRadius: heightInches / 2,
        usable: widthInches / 2,
        curved: false,
        turn,
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

/** Pick the cap height and, if needed, shorten the label so the plate fits. */
export function fitNameplate(
  font: opentype.Font,
  spec: NameplateSpec,
): NameplateLayout | null {
  const rim = spec.rimInches ?? RIM_IN;
  const face = plateFace(spec, rim);
  const label = spec.label.trim();
  if (!label && !spec.compass) return null;

  const needed = (cap: number, text: string, compass: boolean) =>
    (text ? measureTextWidth(font, text, fontSizeForCapHeight(font, cap)) : 0) +
    (compass ? ARROW_SIZE_CAPS * cap : 0) +
    (text && compass ? ARROW_GAP_CAPS * cap : 0) +
    2 * END_MARGIN_CAPS * cap;

  let cap = Math.min(
    MAX_CAP_IN,
    Math.max(MIN_CAP_IN, CAP_FRACTION * chamferSlopeInches(rim)),
  );
  if (needed(cap, label, spec.compass) > face.usable) {
    // Shrink proportionally, then clamp to the printable floor.
    const widthAtCap = needed(cap, label, spec.compass);
    cap = Math.max(MIN_CAP_IN, cap * (face.usable / widthAtCap));
  }

  let text = label;
  while (text && needed(cap, text, spec.compass) > face.usable) {
    const trimmed = text.replace(/…$/, "").slice(0, -1).trimEnd();
    text = trimmed ? trimmed + "…" : "";
  }
  if (!text && !spec.compass) return null;
  return { capInches: cap, text, compass: spec.compass };
}

/**
 * Pocket solids for the plate (one per glyph, plus the arrow), in model
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
  const arrowSize = layout.compass ? ARROW_SIZE_CAPS * cap : 0;
  const gap = layout.text && layout.compass ? ARROW_GAP_CAPS * cap : 0;
  const total = textWidth + gap + arrowSize;
  const startX = -total / 2;

  // Text and the arrow each have an x position along the face; glyph
  // contours are built around their own center, then placed.
  const items: Array<{ contours: Contour[]; x: number }> = [];
  if (layout.text) {
    for (const g of layoutGlyphs(font, layout.text, fontSize)) {
      items.push({
        contours: g.contours.map((c) =>
          c.map(([x, y]) => [x - g.centerX, y - cap / 2]),
        ),
        x: startX + g.centerX,
      });
    }
  }
  if (layout.compass) {
    items.push({ contours: [], x: startX + textWidth + gap + arrowSize / 2 });
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
      const spin = angleDeg + face.turn + spec.rotation;

      let contours = item.contours;
      if (contours.length === 0) {
        // The arrow: point it at true north. In face space "up" is toward
        // the model center, which is north only before the spin, so the
        // arrow is turned back by the same amount.
        contours = [rotateContour(compassContour(arrowSize), -spin)];
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
