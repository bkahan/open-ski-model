// Runs and lifts as solid color bodies set flush into smooth terrain, one
// per filament. The white body is the terrain with those pockets cut out,
// so together the bodies are exactly the original solid.
//
// The colors are worked out in plan first, where the print rules are easy
// to hold: who keeps the ground at a crossing, nothing narrower than the
// nozzle can lay, no white wall too thin to print. Each color's plan then
// becomes a pocket that follows the surface at a fixed depth.
//
// Plans are in the model plane: x east, z north, inches.

import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";

import { pipeSections, prismFromSection, signedArea, thinnedLine } from "./silhouette";
import type { Contour } from "./text";

const MM_PER_INCH = 25.4;

/** Three 0.2 mm layers: enough for a dark color to cover white. */
export const INLAY_DEPTH_IN = 0.6 / MM_PER_INCH;
/** Color narrower than twice this can't be laid down cleanly. */
const MIN_COLOR_HALF_WIDTH_IN = 0.4 / MM_PER_INCH;
/** White narrower than twice this is one broken line or nothing at all. */
const MIN_WHITE_HALF_WIDTH_IN = 0.2 / MM_PER_INCH;
const MIN_ISLAND_AREA_IN2 = 1 / (MM_PER_INCH * MM_PER_INCH);
/** Rings smaller than this are leftovers of the plan's own arithmetic, not features. */
const DEBRIS_AREA_IN2 = 0.01 / (MM_PER_INCH * MM_PER_INCH);
/** Color stops short of the model's edge, which keeps a white wall around it. */
const EDGE_MARGIN_IN = 0.8 / MM_PER_INCH;
/** How far a color reaches to take over a strip of white too thin to print. */
const WHITE_REACH_IN = 2.2 * MIN_WHITE_HALF_WIDTH_IN;
const POINT_SPACING_IN = 0.02;
const JOINT_SIDES = 12;
const ARC_SEGMENTS = 12;
/** Only merges near-duplicate points; anything coarser visibly narrows a ribbon. */
const SIMPLIFY_IN = 0.02 / MM_PER_INCH;
/** Closes the hairline seams left between colors that meet edge to edge. */
const SEAM_IN = 0.01 / MM_PER_INCH;
/** Anything thinner than twice this is a whisker left by the plan's own arithmetic. */
const WHISKER_IN = 0.01 / MM_PER_INCH;
/** The pocket cutters stand this far above the summit, clear of the surface. */
const CUTTER_HEADROOM_IN = 1;

export interface InlayPath {
  /** Centerline in the model plane. */
  points: Array<[number, number]>;
  halfWidth: number;
}

export interface InlayGroup {
  /** Color these paths print in. */
  key: string;
  paths: InlayPath[];
}

export interface InlaySpec {
  /** Highest priority first: where two colors cross, the earlier one keeps the ground. */
  groups: InlayGroup[];
  /** Extra clearance from the edge, for a footprint only as exact as the elevation grid. */
  edgeMarginInches?: number;
}

export interface ColorInlay {
  key: string;
  solid: Manifold;
}

export interface InlaidTerrain {
  /** The terrain with every color's pocket cut out. */
  terrain: Manifold;
  inlays: ColorInlay[];
}

export interface ColorPlan {
  key: string;
  /** Where the color prints, seen from above. */
  section: CrossSection;
}

/** The constructor throws when handed no polygons, so an empty section is made another way. */
function sectionFrom(m: ManifoldToplevel, polygons: Contour[]): CrossSection {
  return polygons.length > 0 ? new m.CrossSection(polygons, "NonZero") : m.CrossSection.compose([]);
}

/** Every path as round-jointed strips, built as one polygon soup. */
function ribbonSection(m: ManifoldToplevel, paths: InlayPath[]): CrossSection {
  const polygons: Contour[] = [];
  for (const { points, halfWidth } of paths) {
    if (points.length === 0) continue;
    const line = thinnedLine(points, POINT_SPACING_IN);
    line.forEach(([x, z], i) => {
      polygons.push(
        Array.from({ length: JOINT_SIDES }, (_, side): [number, number] => {
          const a = (side / JOINT_SIDES) * Math.PI * 2;
          return [x + halfWidth * Math.cos(a), z + halfWidth * Math.sin(a)];
        }),
      );
      if (i + 1 === line.length) return;
      const [nextX, nextZ] = line[i + 1];
      const length = Math.hypot(nextX - x, nextZ - z);
      if (length === 0) return;
      const nx = (-(nextZ - z) / length) * halfWidth;
      const nz = ((nextX - x) / length) * halfWidth;
      polygons.push([
        [x - nx, z - nz],
        [nextX - nx, nextZ - nz],
        [nextX + nx, nextZ + nz],
        [x + nx, z + nz],
      ]);
    });
  }
  return sectionFrom(m, polygons);
}

/** What survives shrinking by `radius` and growing back: the parts at least that wide. */
function opened(section: CrossSection, radius: number): CrossSection {
  return pipeSections(section.simplify(SIMPLIFY_IN), [
    (s) => s.offset(-radius, "Round", 2, ARC_SEGMENTS),
    (s) => s.offset(radius, "Round", 2, ARC_SEGMENTS),
    (s) => s.intersect(section),
  ]);
}

function withoutSmallIslands(m: ManifoldToplevel, section: CrossSection): CrossSection {
  const parts = section.decompose();
  try {
    return m.CrossSection.compose(parts.filter((p) => p.area() >= MIN_ISLAND_AREA_IN2));
  } finally {
    for (const p of parts) p.delete();
  }
}

/**
 * Clipping and offsetting leave hairline whiskers, zero-area needles and
 * pinprick holes behind. As solids they would be paper-thin fins and
 * loose specks in the pockets.
 */
function withoutDebris(m: ManifoldToplevel, section: CrossSection): CrossSection {
  const shaved = pipeSections(section.offset(-WHISKER_IN, "Miter", 2), [
    (s) => s.offset(WHISKER_IN, "Miter", 2),
  ]);
  try {
    const rings = (shaved.toPolygons() as Contour[]).filter(
      (ring) => Math.abs(signedArea(ring)) >= DEBRIS_AREA_IN2,
    );
    return sectionFrom(m, rings);
  } finally {
    shaved.delete();
  }
}

function freePlans(plans: ColorPlan[]): void {
  for (const { section } of plans) section.delete();
}

/** Each color's printable area inside `allowed`, crossings settled by priority. */
function claimGround(m: ManifoldToplevel, groups: InlayGroup[], allowed: CrossSection): ColorPlan[] {
  const plans: ColorPlan[] = [];
  let claimed: CrossSection | null = null;
  try {
    for (const group of groups) {
      const whole: CrossSection = pipeSections(ribbonSection(m, group.paths), [(s) => s.intersect(allowed)]);
      try {
        const section = pipeSections(claimed ? whole.subtract(claimed) : whole.translate([0, 0]), [
          (s) => opened(s, MIN_COLOR_HALF_WIDTH_IN),
          (s) => withoutSmallIslands(m, s),
        ]);
        if (section.isEmpty()) section.delete();
        else plans.push({ key: group.key, section });
        // A crossing stays with the higher color even where that color was too thin to keep.
        const next: CrossSection = claimed ? claimed.add(whole) : whole.translate([0, 0]);
        claimed?.delete();
        claimed = next;
      } finally {
        whole.delete();
      }
    }
    return plans;
  } catch (err) {
    freePlans(plans);
    throw err;
  } finally {
    claimed?.delete();
  }
}

/** The white left between and around the colors that is too thin to print. */
function thinWhite(
  m: ManifoldToplevel,
  plans: ColorPlan[],
  footprint: CrossSection,
  allowed: CrossSection,
): CrossSection {
  const colored = m.CrossSection.union(plans.map((p) => p.section));
  try {
    const white = footprint.subtract(colored);
    try {
      const printable = opened(white, MIN_WHITE_HALF_WIDTH_IN);
      try {
        return pipeSections(white.subtract(printable), [(s) => s.intersect(allowed)]);
      } finally {
        printable.delete();
      }
    } finally {
      white.delete();
    }
  } finally {
    colored.delete();
  }
}

/**
 * Hands every strip of white too thin to print to a color beside it, the
 * highest priority first. Left alone, the slicer would drop the strip and
 * leave a slot between two colors. Takes over `plans` and frees them.
 */
function absorbThinWhite(
  m: ManifoldToplevel,
  plans: ColorPlan[],
  footprint: CrossSection,
  allowed: CrossSection,
): ColorPlan[] {
  const grown: ColorPlan[] = [];
  let thin: CrossSection | null = null;
  try {
    if (plans.length === 0) return grown;
    thin = thinWhite(m, plans, footprint, allowed);
    for (const { key, section } of plans) {
      const reach = section.offset(WHITE_REACH_IN, "Round", 2, ARC_SEGMENTS);
      try {
        const gain = thin.intersect(reach);
        try {
          // Reach is distance, not contact: a strip can be in range without
          // touching this color, and would be a loose speck of it.
          const tidy = pipeSections(section.add(gain), [
            (s) => withoutDebris(m, s),
            (s) => withoutSmallIslands(m, s),
          ]);
          try {
            const rest = thin.subtract(tidy);
            thin.delete();
            thin = rest;
            if (!tidy.isEmpty()) grown.push({ key, section: tidy.translate([0, 0]) });
          } finally {
            tidy.delete();
          }
        } finally {
          gain.delete();
        }
      } finally {
        reach.delete();
      }
    }
    return grown;
  } catch (err) {
    freePlans(grown);
    throw err;
  } finally {
    thin?.delete();
    freePlans(plans);
  }
}

/**
 * Where each color prints, seen from above. No two share more than
 * clipping noise (tens of square microns at worst), and none comes within
 * the edge margin of `footprint`. The caller frees the sections.
 */
export function planColors(m: ManifoldToplevel, footprint: Contour, spec: InlaySpec): ColorPlan[] {
  const footprintSection = new m.CrossSection([footprint], "NonZero");
  try {
    const margin = EDGE_MARGIN_IN + (spec.edgeMarginInches ?? 0);
    const allowed = footprintSection.offset(-margin, "Round", 2, ARC_SEGMENTS);
    try {
      return absorbThinWhite(m, claimGround(m, spec.groups, allowed), footprintSection, allowed);
    } finally {
      allowed.delete();
    }
  } finally {
    footprintSection.delete();
  }
}

/**
 * Everything in the column over `section` from `depth` under the surface
 * upward. `lowered` is the terrain moved down by that depth.
 */
function pocketCutter(section: CrossSection, lowered: Manifold, height: number): Manifold {
  const column = prismFromSection(section, height);
  try {
    return column.subtract(lowered);
  } finally {
    column.delete();
  }
}

/**
 * Split a smooth terrain solid (base on y = 0, cut to `footprint`) into a
 * white body and one flush body per color. The caller owns the results;
 * `terrain` is left alone.
 */
export function inlayTerrain(
  m: ManifoldToplevel,
  terrain: Manifold,
  footprint: Contour,
  spec: InlaySpec,
): InlaidTerrain {
  const plans = planColors(m, footprint, spec);
  if (plans.length === 0) return { terrain: terrain.translate([0, 0, 0]), inlays: [] };

  const inlays: ColorInlay[] = [];
  let lowered: Manifold | null = null;
  try {
    const height = terrain.boundingBox().max[1] + CUTTER_HEADROOM_IN;
    lowered = terrain.translate([0, -INLAY_DEPTH_IN, 0]);
    for (const { key, section } of plans) {
      const cutter = pocketCutter(section, lowered, height);
      try {
        inlays.push({ key, solid: m.Manifold.intersection(terrain, cutter) });
      } finally {
        cutter.delete();
      }
    }
    // One cutter from the merged plan, not a union of the color cutters:
    // neighboring colors share walls exactly, which solid booleans handle badly.
    // Sealing the seams keeps paper-thin white walls out of the pockets.
    const everyColor = pipeSections(m.CrossSection.union(plans.map((p) => p.section)), [
      (s) => s.offset(SEAM_IN, "Miter", 2),
      (s) => s.offset(-SEAM_IN, "Miter", 2),
    ]);
    try {
      const cutter = pocketCutter(everyColor, lowered, height);
      try {
        return { terrain: terrain.subtract(cutter), inlays };
      } finally {
        cutter.delete();
      }
    } finally {
      everyColor.delete();
    }
  } catch (err) {
    for (const { solid } of inlays) solid.delete();
    throw err;
  } finally {
    lowered?.delete();
    freePlans(plans);
  }
}
