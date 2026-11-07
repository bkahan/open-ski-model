// Text → extruded-polygon mesh via opentype.js + Babylon's
// PolygonMeshBuilder. We bundle Roboto Regular (Apache-2.0, ~170 KB)
// and load it once on demand. The resulting mesh is positioned in
// (x, 0..-depth, z) — Y is the extrude axis (depth pushes downward in
// Babylon's ExtrudePolygon convention) — caller transforms it into
// place on the plinth bevel.
//
// Mental model: each glyph in `text` becomes one or more extruded
// 2D polygons. Closed contours with positive signed area (CCW in
// math / +y-up coords) are OUTER shapes; negative-area contours are
// HOLES (think the inside of an 'O' or 'a').

import { MeshBuilder, Mesh, Scene, Vector3 } from "@babylonjs/core";
import earcut from "earcut";
import type { Manifold, ManifoldToplevel } from "manifold-3d";
import * as opentype from "opentype.js";

import { extrudeContours } from "./manifold";

let cachedFont: opentype.Font | null = null;
let loadingPromise: Promise<opentype.Font> | null = null;

const FONT_URL = "/fonts/Roboto-Regular.ttf";

export async function loadFont(): Promise<opentype.Font> {
  if (cachedFont) return cachedFont;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const res = await fetch(FONT_URL);
    if (!res.ok) throw new Error(`failed to fetch font: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    cachedFont = opentype.parse(buf);
    return cachedFont;
  })();
  return loadingPromise;
}

/**
 * Signed area of a 2D polygon. Positive = CCW (math/+y-up). For
 * opentype paths (which are Y-DOWN), we'll flip y first so the same
 * convention applies.
 */
function signedArea(poly: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * Point-in-polygon (ray cast). Used to attach holes to their parent
 * outer contours.
 */
function pointInPoly(px: number, py: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Convert an opentype path to a list of CLOSED 2D contours in +y-up
 * coords. Each contour is an array of [x, y] points.
 *
 * Curves are sampled at `segments` straight segments per curve. 8 is
 * usually enough for engraving — the surface gets smoothed out by
 * print resolution anyway.
 */
function pathToContours(
  path: opentype.Path,
  curveSegments = 8,
): Array<Array<[number, number]>> {
  const contours: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let lastX = 0;
  let lastY = 0;
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        if (current.length) contours.push(current);
        current = [];
        lastX = cmd.x;
        lastY = cmd.y;
        current.push([cmd.x, -cmd.y]); // flip Y to +up
        break;
      case "L":
        lastX = cmd.x;
        lastY = cmd.y;
        current.push([cmd.x, -cmd.y]);
        break;
      case "C":
        // Cubic bezier from (lastX, lastY) via (x1, y1), (x2, y2) to (x, y).
        for (let s = 1; s <= curveSegments; s++) {
          const t = s / curveSegments;
          const u = 1 - t;
          const x =
            u * u * u * lastX +
            3 * u * u * t * cmd.x1 +
            3 * u * t * t * cmd.x2 +
            t * t * t * cmd.x;
          const y =
            u * u * u * lastY +
            3 * u * u * t * cmd.y1 +
            3 * u * t * t * cmd.y2 +
            t * t * t * cmd.y;
          current.push([x, -y]);
        }
        lastX = cmd.x;
        lastY = cmd.y;
        break;
      case "Q":
        // Quadratic bezier from (lastX, lastY) via (x1, y1) to (x, y).
        for (let s = 1; s <= curveSegments; s++) {
          const t = s / curveSegments;
          const u = 1 - t;
          const x = u * u * lastX + 2 * u * t * cmd.x1 + t * t * cmd.x;
          const y = u * u * lastY + 2 * u * t * cmd.y1 + t * t * cmd.y;
          current.push([x, -y]);
        }
        lastX = cmd.x;
        lastY = cmd.y;
        break;
      case "Z":
        if (current.length) {
          contours.push(current);
          current = [];
        }
        break;
    }
  }
  if (current.length) contours.push(current);
  return contours;
}

interface GlyphGroup {
  outer: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
}

/** Group contours into outer-with-holes pairs by signed-area sign + containment. */
function groupContours(
  contours: Array<Array<[number, number]>>,
): GlyphGroup[] {
  const outers: GlyphGroup[] = [];
  const holes: Array<Array<[number, number]>> = [];
  for (const c of contours) {
    if (c.length < 3) continue;
    if (signedArea(c) > 0) {
      outers.push({ outer: c, holes: [] });
    } else {
      holes.push(c);
    }
  }
  // Assign each hole to whichever outer contains its first vertex.
  for (const h of holes) {
    const [hx, hy] = h[0];
    for (const o of outers) {
      if (pointInPoly(hx, hy, o.outer)) {
        o.holes.push(h);
        break;
      }
    }
  }
  return outers;
}

export interface TextMeshOptions {
  /** Loaded opentype font. */
  font: opentype.Font;
  /** Text to render. */
  text: string;
  /** Cap height in inches (== opentype font-size). */
  size: number;
  /** Extrusion depth in inches (positive). */
  depth: number;
  /** Target scene. */
  scene: Scene;
  /** Optional name prefix for created meshes. */
  name?: string;
}

/**
 * Build a single combined mesh for `text`. Returns null if the string
 * has no visible glyphs.
 *
 * The mesh sits in the X-Z plane (Y is extrude axis). Origin is at the
 * baseline / left edge of the text. Caller is expected to:
 *   - position the mesh on the plinth,
 *   - rotate it so the text reads correctly,
 *   - and CSG-subtract it from the plinth (the depth pushes "into" the
 *     bevel face).
 */
export function buildTextMesh(opts: TextMeshOptions): Mesh | null {
  const { font, text, size, depth, scene } = opts;
  if (!text) return null;

  // opentype.getPath returns a path positioned at (x, y) with the given
  // font size (= em size in font units → scaled to size inches).
  const path = font.getPath(text, 0, 0, size);
  const contours = pathToContours(path);
  if (contours.length === 0) return null;
  const groups = groupContours(contours);
  if (groups.length === 0) return null;

  const meshes: Mesh[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const shape = g.outer.map(([x, y]) => new Vector3(x, 0, y));
    const holes = g.holes.map((h) =>
      h.map(([x, y]) => new Vector3(x, 0, y)),
    );
    try {
      // No DOUBLESIDE — CSG.subtract requires a closed, single-sided
      // mesh. Two-sided polygons turn each face into back-to-back
      // triangles with opposite winding, which CSG treats as a
      // non-manifold.
      const m = MeshBuilder.ExtrudePolygon(
        `${opts.name ?? "text"}-${gi}`,
        { shape, holes, depth },
        scene,
        earcut,
      );
      meshes.push(m);
    } catch (err) {
      // Earcut occasionally fails on degenerate paths (overlapping verts,
      // self-intersecting curves). Skip the bad group.
      console.warn(`[text] glyph group ${gi} failed: ${(err as Error).message}`);
    }
  }
  if (meshes.length === 0) return null;
  // multiMultiMaterials=false → single-material merged mesh, which is
  // what CSG expects.
  const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
  if (merged) merged.name = opts.name ?? "text";
  return merged;
}

/**
 * Glyph outlines for `text` as closed contours in the XY plane, +y up,
 * baseline at y = 0, left edge at x = 0. Outer contours and holes are
 * both included; the consumer's fill rule sorts them out.
 */
export function textContours(
  font: opentype.Font,
  text: string,
  size: number,
): Array<Array<[number, number]>> {
  return pathToContours(font.getPath(text, 0, 0, size)).filter((c) => c.length >= 3);
}

/**
 * Solid text in the XY plane, extruded along +Z from 0 to `depth`.
 * Returns null for a string with no visible glyphs.
 */
export function buildTextSolid(
  m: ManifoldToplevel,
  font: opentype.Font,
  text: string,
  size: number,
  depth: number,
): Manifold | null {
  const contours = textContours(font, text, size);
  if (contours.length === 0) return null;
  return extrudeContours(m, contours, depth);
}

/**
 * Approximate the width of a rendered string in the same units used by
 * buildTextMesh's `size`. Useful for centering / right-aligning.
 */
export function measureTextWidth(
  font: opentype.Font,
  text: string,
  size: number,
): number {
  return font.getAdvanceWidth(text, size);
}
