// The boolean pipeline that turns terrain + options into printable
// solids: plinth with the name plate cut in, brand on the underside,
// and the union used for export. Everything here is Manifold; the
// viewer converts the results to meshes.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { shapeOutline, type Shape } from "@/lib/shape";

import { inlayTerrain, type ColorInlay, type InlaySpec } from "./inlays";
import { manifoldFromMesh, withSolids, type TriMesh } from "./manifold";
import {
  buildNameplateSolids,
  plateTurnDeg,
  POCKET_DEPTH_IN,
  type NameplateLayout,
  type PlateSide,
} from "./nameplate";
import {
  buildPlinthSolid,
  plinthHeightInches,
  SEAT_RECESS_DEPTH_IN,
  SEAT_RECESS_INSET_IN,
  TERRAIN_SEAT_IN,
} from "./plinth";
import { buildOutlinePlinth, OUTLINE_PLINTH_HEIGHT_IN, outlinePrism, prismFromSection } from "./silhouette";
import { buildTextSolid, fontSizeForCapHeight, measureTextWidth, type Contour } from "./text";

const MM_PER_INCH = 25.4;
export const BRAND_TEXT = "craftedcarving.com";
const BRAND_CAP_IN = 3 / MM_PER_INCH;
const BRAND_OVERCUT_IN = 0.01;
/** Taller than any terrain, so the outline cuts all the way through. */
const OUTLINE_CUTTER_HEIGHT_IN = 100;
/** How far the seat's cutter stands above the plinth's top; any height clears it. */
const SEAT_CUTTER_RISE_IN = 1;

/** Height of the plinth's top face: the slab's under an outline, the chamfer's otherwise. */
function plinthTopInches(plinth: boolean, outline: boolean): number {
  if (!plinth) return 0;
  return outline ? OUTLINE_PLINTH_HEIGHT_IN : plinthHeightInches();
}

/** How far the terrain is raised off y = 0: onto the plinth, less its seat. */
export function terrainLiftInches(plinth: boolean, outline: boolean): number {
  return plinth ? plinthTopInches(plinth, outline) - TERRAIN_SEAT_IN : 0;
}

export interface TerrainBase {
  /** Whether a plinth carries the terrain. */
  plinth: boolean;
  /** Height of the terrain's lowest point above the plinth's top. */
  plinthLiftInches: number;
  /** Thickness under the lowest point when the terrain is its own base. */
  baseThicknessInches: number;
}

/**
 * Thickness to build under the terrain's lowest point. On a plinth that is
 * the seat plus the lift, so the lowest ground lands `plinthLiftInches`
 * above the plinth's top.
 */
export function terrainBaseInches(base: TerrainBase): number {
  return base.plinth ? TERRAIN_SEAT_IN + Math.max(0, base.plinthLiftInches) : base.baseThicknessInches;
}

export interface ModelSpec extends PlateSide {
  label: string;
  /** Second line of the name plate, such as "Jay, VT". */
  place?: string;
  /**
   * Plinth with name plate and compass. The terrain mesh must then be
   * built on `terrainBaseInches`: its bottom TERRAIN_SEAT_IN goes into the plinth.
   */
  plinth: boolean;
  /** Brand text on the underside. */
  brand: boolean;
  /** Cut the model to this ring instead of the frame. Model plane, inches. */
  outline?: Contour | null;
  /** Set runs and lifts into the terrain as color bodies. */
  inlays?: InlaySpec | null;
}

export interface BuiltModel {
  /** Terrain, with the brand cut in when there is no plinth. Model space, base at y = 0. */
  terrain: Manifold;
  /** Plinth with pockets and the recess under the terrain cut in, or null. */
  plinth: Manifold | null;
  /** Name-plate fill bodies (one per glyph + the rose), for multicolor printing. */
  inlays: Manifold[];
  /** Run and lift bodies by color, when asked for. Same space as `terrain`. */
  colorInlays: ColorInlay[];
  /** How far the terrain and its color bodies are raised to sit in the plinth. */
  terrainLift: number;
  nameplate: NameplateLayout | null;
}

/**
 * Build the printable solids. The caller owns every Manifold in the
 * result and must delete them.
 */
export function buildModelSolids(
  m: ManifoldToplevel,
  font: opentype.Font,
  terrainMesh: TriMesh,
  spec: ModelSpec,
): BuiltModel {
  // Every solid made here is tracked so a throw midway frees them all;
  // on success only the ones handed back survive.
  const owned = new Set<Manifold>();
  const own = <T extends Manifold>(s: T): T => {
    owned.add(s);
    return s;
  };
  const release = (s: Manifold) => {
    owned.delete(s);
    s.delete();
  };

  try {
    let terrain = own(manifoldFromMesh(m, terrainMesh));
    let plinth: Manifold | null = null;
    let inlays: Manifold[] = [];
    let nameplate: NameplateLayout | null = null;
    const outline = spec.outline ?? null;
    const terrainLift = terrainLiftInches(spec.plinth, outline !== null);

    if (outline) {
      const cutter = own(outlinePrism(m, outline, OUTLINE_CUTTER_HEIGHT_IN));
      const cut = own(m.Manifold.intersection(terrain, cutter));
      release(cutter);
      release(terrain);
      terrain = cut;
    }
    const recess = spec.plinth ? own(seatRecess(terrain, terrainLift)) : null;

    let colorInlays: ColorInlay[] = [];
    if (spec.inlays) {
      const footprint =
        outline ?? shapeOutline(spec.shape, spec.widthInches, spec.heightInches, spec.rotation);
      const inlaid = inlayTerrain(m, terrain, footprint, spec.inlays);
      own(inlaid.terrain);
      for (const inlay of inlaid.inlays) own(inlay.solid);
      release(terrain);
      terrain = inlaid.terrain;
      colorInlays = inlaid.inlays;
    }

    let brandSpin = spec.rotation + plateTurnDeg(spec);
    let brandAt: [number, number] = [0, 0];

    if (spec.plinth) {
      let raw: Manifold;
      let plate: { solids: Manifold[]; layout: NameplateLayout | null };
      if (outline) {
        const built = buildOutlinePlinth(m, font, {
          outline,
          label: spec.label,
          place: spec.place,
          compass: true,
          facing: spec.facing,
        });
        raw = own(built.slab);
        plate = built;
        brandSpin = built.spin;
        brandAt = built.tabCenter;
      } else {
        raw = own(buildPlinthSolid(m, spec));
        plate = buildNameplateSolids(m, font, { ...spec, compass: true });
      }
      if (recess) {
        const recessed = own(m.Manifold.difference(raw, recess));
        release(raw);
        release(recess);
        raw = recessed;
      }
      for (const s of plate.solids) own(s);
      nameplate = plate.layout;
      if (plate.solids.length > 0) {
        const cutter = own(m.Manifold.union(plate.solids));
        // The fill bodies are exactly what the pockets remove.
        inlays = plate.solids.map((s) => own(m.Manifold.intersection(raw, s)));
        plinth = own(m.Manifold.difference(raw, cutter));
        for (const s of [raw, cutter, ...plate.solids]) release(s);
      } else {
        plinth = raw;
      }
    }

    if (spec.brand) {
      const host = plinth ?? terrain;
      // Same side as the plate, so it reads when the model is tipped
      // over its front edge.
      const branded = cutBrand(m, font, host, brandSpin, brandAt);
      if (branded) {
        own(branded);
        release(host);
        if (plinth) plinth = branded;
        else terrain = branded;
      }
    }

    return { terrain, plinth, inlays, colorInlays, terrainLift, nameplate };
  } catch (err) {
    for (const s of owned) s.delete();
    throw err;
  }
}

/**
 * The part of the plinth to clear from under the terrain: the terrain's
 * own footprint drawn in a little, from just under the plinth's top up.
 */
function seatRecess(terrain: Manifold, terrainLift: number): Manifold {
  // Below the seat's top the terrain is all wall, so a slice there is its footprint.
  const stood = terrain.rotate([90, 0, 0]);
  const slice = stood.slice(TERRAIN_SEAT_IN / 2);
  const footprint = slice.scale([1, -1]);
  const inset = footprint.offset(-SEAT_RECESS_INSET_IN, "Miter", 4);
  const prism = prismFromSection(inset, SEAT_RECESS_DEPTH_IN + SEAT_CUTTER_RISE_IN);
  try {
    return prism.translate([0, terrainLift + TERRAIN_SEAT_IN - SEAT_RECESS_DEPTH_IN, 0]);
  } finally {
    for (const s of [stood, slice, footprint, inset, prism]) s.delete();
  }
}

/**
 * Cut the brand into the underside of `host` (bottom face on y = 0),
 * mirrored so it reads when the model is turned over its south edge,
 * centered at `at` (x, z before the spin), then spun about y by `spin`
 * (shapeOutline's degrees). Returns null if the cut fails; the host is
 * left untouched either way.
 */
export function cutBrand(
  m: ManifoldToplevel,
  font: opentype.Font,
  host: Manifold,
  spin: number,
  at: [number, number] = [0, 0],
): Manifold | null {
  const size = fontSizeForCapHeight(font, BRAND_CAP_IN);
  const text = buildTextSolid(m, font, BRAND_TEXT, size, POCKET_DEPTH_IN + BRAND_OVERCUT_IN);
  if (!text) return null;
  const width = measureTextWidth(font, BRAND_TEXT, size);
  // Text in XY, extruded +Z. Turning the model over is a 180° flip, so
  // text that reads from below has glyph "right" along +x and "up"
  // along -z. Lay it flat that way with the extrusion pointing up into
  // the body (y from -overcut to +depth), then spin it into place.
  const centered = text.translate([-width / 2, -BRAND_CAP_IN / 2, -BRAND_OVERCUT_IN]);
  const flat = centered.rotate([-90, 0, 0]);
  const moved = flat.translate([at[0], 0, at[1]]);
  const placed = moved.rotate([0, -spin, 0]);
  const cut = m.Manifold.difference(host, placed);
  return withSolids([text, centered, flat, moved, placed], () => {
    if (cut.status() !== "NoError" || cut.numTri() === 0) {
      cut.delete();
      return null;
    }
    return cut;
  });
}

/** One solid for STL/STEP: terrain lifted into its seat in the plinth, unioned. */
export function unionForExport(m: ManifoldToplevel, built: BuiltModel): Manifold {
  if (!built.plinth) return built.terrain.translate([0, 0, 0]);
  const lifted = built.terrain.translate([0, built.terrainLift, 0]);
  const out = m.Manifold.union(lifted, built.plinth);
  lifted.delete();
  return out;
}
