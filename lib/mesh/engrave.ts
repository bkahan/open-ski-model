// The boolean pipeline that turns terrain + options into printable
// solids: plinth with the name plate cut in, brand on the underside,
// and the union used for export. Everything here is Manifold; the
// viewer converts the results to meshes.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import { shapeOutline, type Shape } from "@/lib/shape";

import { inlayTerrain, type InlaySpec } from "./inlays";
import { manifoldFromMesh, withSolids, type TriMesh } from "./manifold";
import {
  buildNameplateSolids,
  plateTurnDeg,
  POCKET_DEPTH_IN,
  type NameplateLayout,
  type PlateSide,
} from "./nameplate";
import { buildPlinthSolid, plinthHeightInches } from "./plinth";
import { type ColorInlay, stackTerrain, type TerrainLayers } from "./layers";
import { buildOutlinePlinth, OUTLINE_PLINTH_HEIGHT_IN, outlinePrism } from "./silhouette";
import { buildTextSolid, fontSizeForCapHeight, measureTextWidth, type Contour } from "./text";

const MM_PER_INCH = 25.4;
export const BRAND_TEXT = "craftedcarving.com";
const BRAND_CAP_IN = 3 / MM_PER_INCH;
const BRAND_OVERCUT_IN = 0.01;
/** Taller than any terrain, so the outline cuts all the way through. */
const OUTLINE_CUTTER_HEIGHT_IN = 100;

export interface ModelSpec extends PlateSide {
  label: string;
  /** Plinth with name plate and compass. */
  plinth: boolean;
  /** Brand text on the underside. */
  brand: boolean;
  /** Cut the model to this ring instead of the frame. Model plane, inches. */
  outline?: Contour | null;
  /** Rebuild the terrain as flat steps. */
  layers?: TerrainLayers | null;
  /** Set runs and lifts into the smooth terrain as color bodies. Stacked terrain cuts its own. */
  inlays?: InlaySpec | null;
}

export interface BuiltModel {
  /** Terrain, with the brand cut in when there is no plinth. Model space, base at y = 0. */
  terrain: Manifold;
  /** Plinth with pockets, or null. The terrain sits on top at `plinthHeight`. */
  plinth: Manifold | null;
  /** Name-plate fill bodies (one per glyph + the rose), for multicolor printing. */
  inlays: Manifold[];
  /** Run and lift fills by color, when asked for. Same space as `terrain`. */
  grooveInlays: ColorInlay[];
  plinthHeight: number;
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
    const plinthHeight = !spec.plinth
      ? 0
      : outline
        ? OUTLINE_PLINTH_HEIGHT_IN
        : plinthHeightInches();

    if (outline) {
      const cutter = own(outlinePrism(m, outline, OUTLINE_CUTTER_HEIGHT_IN));
      const cut = own(m.Manifold.intersection(terrain, cutter));
      release(cutter);
      release(terrain);
      terrain = cut;
    }

    let grooveInlays: ColorInlay[] = [];
    if (spec.layers) {
      const stacked = stackTerrain(m, terrain, spec.layers);
      own(stacked.terrain);
      for (const inlay of stacked.inlays) own(inlay.solid);
      release(terrain);
      terrain = stacked.terrain;
      grooveInlays = stacked.inlays;
    } else if (spec.inlays) {
      const footprint =
        outline ?? shapeOutline(spec.shape, spec.widthInches, spec.heightInches, spec.rotation);
      const inlaid = inlayTerrain(m, terrain, footprint, spec.inlays);
      own(inlaid.terrain);
      for (const inlay of inlaid.inlays) own(inlay.solid);
      release(terrain);
      terrain = inlaid.terrain;
      grooveInlays = inlaid.inlays;
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

    return { terrain, plinth, inlays, grooveInlays, plinthHeight, nameplate };
  } catch (err) {
    for (const s of owned) s.delete();
    throw err;
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

/** One solid for STL/STEP: terrain lifted onto the plinth, unioned. */
export function unionForExport(m: ManifoldToplevel, built: BuiltModel): Manifold {
  if (!built.plinth) return built.terrain.translate([0, 0, 0]);
  const lifted = built.terrain.translate([0, built.plinthHeight, 0]);
  const out = m.Manifold.union(lifted, built.plinth);
  lifted.delete();
  return out;
}
