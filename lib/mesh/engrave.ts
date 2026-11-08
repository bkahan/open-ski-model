// The boolean pipeline that turns terrain + options into printable
// solids: plinth with the name plate cut in, brand on the underside,
// and the union used for export. Everything here is Manifold; the
// viewer converts the results to meshes.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type * as opentype from "opentype.js";

import type { Shape } from "@/lib/shape";

import { manifoldFromMesh, withSolids, type TriMesh } from "./manifold";
import { buildNameplateSolids, POCKET_DEPTH_IN, type NameplateLayout } from "./nameplate";
import { buildPlinthSolid, plinthHeightInches } from "./plinth";
import { buildTextSolid, fontSizeForCapHeight, measureTextWidth } from "./text";

const MM_PER_INCH = 25.4;
export const BRAND_TEXT = "craftedcarving.com";
const BRAND_CAP_IN = 3 / MM_PER_INCH;
const BRAND_OVERCUT_IN = 0.01;

export interface ModelSpec {
  shape: Shape;
  widthInches: number;
  heightInches: number;
  rotation: number;
  label: string;
  /** Plinth with name plate and compass. */
  plinth: boolean;
  /** Brand text on the underside. */
  brand: boolean;
}

export interface BuiltModel {
  /** Terrain, with the brand cut in when there is no plinth. Model space, base at y = 0. */
  terrain: Manifold;
  /** Plinth with pockets, or null. The terrain sits on top at `plinthHeight`. */
  plinth: Manifold | null;
  /** Name-plate fill bodies (one per glyph + arrow), for multicolor printing. */
  inlays: Manifold[];
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
    const plinthHeight = spec.plinth ? plinthHeightInches() : 0;

    if (spec.plinth) {
      const raw = own(buildPlinthSolid(m, spec));
      const plate = buildNameplateSolids(m, font, { ...spec, compass: true });
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
      const branded = cutBrand(m, font, host, spec.rotation);
      if (branded) {
        own(branded);
        release(host);
        if (plinth) plinth = branded;
        else terrain = branded;
      }
    }

    return { terrain, plinth, inlays, plinthHeight, nameplate };
  } catch (err) {
    for (const s of owned) s.delete();
    throw err;
  }
}

/**
 * Cut the brand into the underside of `host` (bottom face on y = 0),
 * mirrored so it reads when the model is turned over. Returns null if
 * the cut fails; the host is left untouched either way.
 */
export function cutBrand(
  m: ManifoldToplevel,
  font: opentype.Font,
  host: Manifold,
  rotation: number,
): Manifold | null {
  const size = fontSizeForCapHeight(font, BRAND_CAP_IN);
  const text = buildTextSolid(m, font, BRAND_TEXT, size, POCKET_DEPTH_IN + BRAND_OVERCUT_IN);
  if (!text) return null;
  const width = measureTextWidth(font, BRAND_TEXT, size);
  // Text in XY, extruded +Z. Turning the model over is a 180° flip, so
  // text that reads from below has glyph "right" along +x and "up"
  // along -z. Lay it flat that way with the extrusion pointing up into
  // the body (y from -overcut to +depth), then follow the model's
  // rotation.
  const centered = text.translate([-width / 2, -BRAND_CAP_IN / 2, -BRAND_OVERCUT_IN]);
  const flat = centered.rotate([-90, 0, 0]);
  const placed = flat.rotate([0, -rotation, 0]);
  const cut = m.Manifold.difference(host, placed);
  return withSolids([text, centered, flat, placed], () => {
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
