// Build a watertight VertexData mesh from an elevation height grid.
//
// Mental model: the grid is a tablecloth draped over a square table. Phase 2
// rendered just the cloth. Phase 3 also sews the cloth to the table edges
// (four side walls) and adds the table top (a single flat bottom quad).
//
// Watertight means every triangle edge is shared by exactly two triangles.
// We get that by:
//   - Re-creating the perimeter top vertices for each side wall (so the
//     crease where the cloth meets the wall is sharp — averaged normals
//     would look bevelled). The crease shares only a *position*, not a
//     vertex, between the top surface and the wall.
//   - Using the same four bottom-corner positions for the bottom face and
//     each adjacent side wall's bottom edge (so the floor seams stay
//     closed).
//
// Winding is consistent CCW from outside, so ComputeNormals produces
// outward-facing normals — required for STL export.

import { VertexData } from "@babylonjs/core";

import type { Bbox } from "@/lib/types";
import { bboxWidthMeters } from "@/lib/bbox";
import type { ElevationResponse } from "@/lib/elevation/types";
import { pointInShape, shapeAABBHalf, type Shape } from "@/lib/shape";

export interface WatertightSpec {
  bbox: Bbox;
  data: ElevationResponse;
  /** Shape pre-rotation width in inches. */
  widthInches: number;
  /** Shape pre-rotation height in inches. */
  heightInches: number;
  /** Height of the lowest kept point above the model's underside. */
  baseThicknessInches: number;
  verticalExaggeration: number;
  /**
   * Elevation in meters that sits at the base thickness. Defaults to the
   * grid's minimum; ground below it is held level at the base.
   */
  floorElevation?: number;
}

export interface Palette {
  /** Returns [r,g,b] in 0..1 given a normalized elevation 0..1. */
  surface: (t: number) => [number, number, number];
  /** Color for side walls + base. */
  base: [number, number, number];
}

export const DEFAULT_PALETTE: Palette = {
  surface: hypsometric,
  base: [0.18, 0.20, 0.25],
};

/**
 * Build a closed, oriented watertight VertexData for the given spec.
 * Returns also the inches-per-meter scale used (helpful for contour math).
 */
export function buildWatertight(
  spec: WatertightSpec,
  palette: Palette = DEFAULT_PALETTE,
): { vertexData: VertexData; inPerMeter: number; topYFn: (k: number) => number } {
  const {
    bbox,
    data,
    widthInches: W,
    heightInches: H,
    baseThicknessInches: base,
    verticalExaggeration: vx,
  } = spec;
  const { heights, width: gw, height: gh, min, max } = data;

  const bboxWMeters = bboxWidthMeters(bbox);
  const inPerMeter = W / bboxWMeters;

  // Precompute every grid cell's "top y" — the absolute height of the
  // terrain surface above the model origin. Used in both top surface and
  // side walls so they line up exactly.
  const floor = spec.floorElevation ?? min;
  const topY = new Float32Array(gw * gh);
  for (let k = 0; k < gw * gh; k++) {
    topY[k] = base + Math.max(0, heights[k] - floor) * inPerMeter * vx;
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const pushColor = (c: [number, number, number]) => {
    colors.push(c[0], c[1], c[2], 1);
  };
  const xAt = (i: number) => -W / 2 + (i * W) / (gw - 1);
  const zAt = (j: number) => H / 2 - (j * H) / (gh - 1);

  // ---------- 1. TOP SURFACE ----------
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      positions.push(xAt(i), topY[k], zAt(j));
      const t = max > min ? (heights[k] - min) / (max - min) : 0;
      pushColor(palette.surface(t));
    }
  }
  // CCW from above (a,b,c) gives +Y normal — see the cross-product derivation
  // in the README's "How the mesh is built" section.
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i;
      const b = j * gw + i + 1;
      const c = (j + 1) * gw + i;
      const d = (j + 1) * gw + i + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  // ---------- 2. BOTTOM PERIMETER RING ----------
  // One vertex at y = 0 under every perimeter top vertex, in order around
  // the footprint: north row west→east, east column north→south, south
  // row east→west, west column south→north. The walls and the bottom
  // face both index into this ring, so the base has no T-junctions and
  // the solid is manifold for boolean work.
  const ringStart = positions.length / 3;
  const ringLen = 2 * gw + 2 * gh - 4;
  const pushRing = (x: number, z: number) => {
    positions.push(x, 0, z);
    pushColor(palette.base);
  };
  for (let i = 0; i < gw; i++) pushRing(xAt(i), +H / 2);
  for (let j = 1; j < gh; j++) pushRing(+W / 2, zAt(j));
  for (let i = gw - 2; i >= 0; i--) pushRing(xAt(i), -H / 2);
  for (let j = gh - 2; j >= 1; j--) pushRing(-W / 2, zAt(j));
  const ring = (k: number) => ringStart + ((k % ringLen) + ringLen) % ringLen;

  // Ring positions of the four corners, for the walls below.
  const NW = 0;
  const NE = gw - 1;
  const SE = gw - 1 + (gh - 1);
  const SW = SE + (gw - 1);

  // Bottom face: fan from a center vertex over a second copy of the ring
  // (same positions, own normals, so the crease to the walls stays
  // sharp; the copies merge by position for boolean work). The ring runs
  // clockwise seen from above, so (center, next, current) → -Y normal.
  const bottomRingStart = positions.length / 3;
  for (let k = 0; k < ringLen; k++) {
    const r = ring(k) * 3;
    pushRing(positions[r], positions[r + 2]);
  }
  const bottomRing = (k: number) => bottomRingStart + (k % ringLen);
  const bottomCenter = positions.length / 3;
  positions.push(0, 0, 0);
  pushColor(palette.base);
  for (let k = 0; k < ringLen; k++) {
    indices.push(bottomCenter, bottomRing(k + 1), bottomRing(k));
  }

  // ---------- 3. SIDE WALLS ----------
  // Helper: build one wall strip. `topRow` enumerates (k, x, z) pairs for
  // the top edge in order; `ringAt(i)` gives the ring index under top[i];
  // outwardFlip picks the winding that faces outward.
  type WallVertex = { k: number; x: number; z: number };
  const buildWall = (
    topRow: WallVertex[],
    outwardFlip: boolean,
    ringAt: (i: number) => number,
  ) => {
    const wallStart = positions.length / 3;

    // Top vertices (duplicated from the top surface for the sharp crease)
    for (const v of topRow) {
      positions.push(v.x, topY[v.k], v.z);
      pushColor(palette.base);
    }

    const n = topRow.length;
    for (let i = 0; i < n - 1; i++) {
      const V0 = wallStart + i;          // top[i]
      const V1 = wallStart + i + 1;      // top[i+1]
      const V2 = ringAt(i);              // bot[i]
      const V3 = ringAt(i + 1);          // bot[i+1]
      if (outwardFlip) {
        indices.push(V0, V1, V2, V1, V3, V2);
      } else {
        indices.push(V0, V2, V1, V1, V2, V3);
      }
    }
  };

  // NORTH wall — j=0 row, z = +H/2, outward normal = +Z, NO flip.
  buildWall(
    Array.from({ length: gw }, (_, i) => ({ k: i, x: xAt(i), z: +H / 2 })),
    false,
    (i) => ring(NW + i),
  );
  // SOUTH wall — j=gh-1 row, z = -H/2, outward normal = -Z, FLIP.
  buildWall(
    Array.from({ length: gw }, (_, i) => ({
      k: (gh - 1) * gw + i,
      x: xAt(i),
      z: -H / 2,
    })),
    true,
    (i) => ring(SW - i),
  );
  // WEST wall — i=0 column, x = -W/2, outward normal = -X.
  // We walk north→south, so going forward decreases z. With our default
  // winding convention (no flip), that came out as -X — exactly what we want.
  buildWall(
    Array.from({ length: gh }, (_, j) => ({
      k: j * gw + 0,
      x: -W / 2,
      z: zAt(j),
    })),
    true,
    (j) => ring(NW - j),
  );
  // EAST wall — i=gw-1 column, x = +W/2, outward normal = +X, FLIP.
  buildWall(
    Array.from({ length: gh }, (_, j) => ({
      k: j * gw + (gw - 1),
      x: +W / 2,
      z: zAt(j),
    })),
    false,
    (j) => ring(NE + j),
  );

  // ---------- Pack into typed arrays ----------
  const positionsArr = new Float32Array(positions);
  const colorsArr = new Float32Array(colors);
  const indicesArr = new Uint32Array(indices);
  const normals = new Float32Array(positionsArr.length);
  // Babylon's default scene is left-handed, which inverts the sign of the
  // facet normal computed from CCW winding. Our derivations above assume
  // a right-handed cross product, so we tell ComputeNormals to use that
  // convention — it negates the per-face sign and our outward normals
  // come out correct. Without this flag, the STL exports inside-out and
  // lighting looks inverted (sun-lit faces appear dark).
  VertexData.ComputeNormals(positionsArr, indicesArr, normals, {
    useRightHandedSystem: true,
  });

  const vd = new VertexData();
  vd.positions = positionsArr;
  vd.indices = indicesArr;
  vd.normals = normals;
  vd.colors = colorsArr;

  return {
    vertexData: vd,
    inPerMeter,
    topYFn: (k) => topY[k],
  };
}

/**
 * Shape-aware watertight build. Used for non-rectangular shapes (circle,
 * hexagon). The shape is inscribed in the bbox / print canvas; cells
 * whose 4 corners all fall inside the shape are kept, others are skipped,
 * and side walls follow the staircase boundary of the kept region.
 *
 * Mental model:
 *   - The cap (top surface) is the kept-cell quads stitched together,
 *     just like the rectangle path but with rejected cells punched out.
 *   - The bottom is a flat copy of the cap footprint at y = 0, with
 *     reversed winding so the normal points down.
 *   - The walls are emitted per cell: for every kept cell, each side that
 *     borders a rejected cell (or the grid edge) gets a vertical strip.
 *     Walking each cell's perimeter CCW (viewed from above) is what makes
 *     the wall outward-normals come out correct without per-side flip
 *     bookkeeping.
 *
 * The boundary is staircase-quantized to grid cells. At 256×256 that's
 * ~0.4% of the model width per step — visually invisible at typical
 * print sizes, but the model is honestly a hex / circle now, not a
 * rectangle styled to look like one.
 */
export function buildShapedWatertight(
  spec: WatertightSpec,
  shape: Shape,
  rotation: number,
  palette: Palette = DEFAULT_PALETTE,
): { vertexData: VertexData; inPerMeter: number; topYFn: (k: number) => number } {
  const {
    bbox,
    data,
    widthInches: shapeWIn,
    heightInches: shapeHIn,
    baseThicknessInches: base,
    verticalExaggeration: vx,
  } = spec;
  const { heights, width: gw, height: gh, min, max } = data;

  // The grid spans the AABB of the rotated shape. The shape itself
  // (pre-rotation widthInches × heightInches, rotated by `rotation`) is
  // inscribed in the AABB.
  const [aabbHalfW, aabbHalfH] = shapeAABBHalf(
    shape,
    shapeWIn,
    shapeHIn,
    rotation,
  );
  const W = aabbHalfW * 2;
  const H = aabbHalfH * 2;

  const bboxWMeters = bboxWidthMeters(bbox);
  const inPerMeter = W / bboxWMeters;

  const floor = spec.floorElevation ?? min;
  const topY = new Float32Array(gw * gh);
  for (let k = 0; k < gw * gh; k++) {
    topY[k] = base + Math.max(0, heights[k] - floor) * inPerMeter * vx;
  }

  const xAt = (i: number) => -W / 2 + (i * W) / (gw - 1);
  const zAt = (j: number) => H / 2 - (j * H) / (gh - 1);

  // Vertex-inside mask, then cell-kept mask (cell kept iff all 4 corners in).
  const vIn = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      vIn[j * gw + i] = pointInShape(
        shape,
        xAt(i),
        zAt(j),
        shapeWIn,
        shapeHIn,
        rotation,
      )
        ? 1
        : 0;
    }
  }
  const cw = gw - 1;
  const ch = gh - 1;
  const cellKept = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      cellKept[j * cw + i] =
        vIn[j * gw + i] &
        vIn[j * gw + i + 1] &
        vIn[(j + 1) * gw + i] &
        vIn[(j + 1) * gw + i + 1];
    }
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const pushColor = (c: [number, number, number]) => {
    colors.push(c[0], c[1], c[2], 1);
  };

  // ---------- 1. TOP SURFACE ----------
  // Emit all grid vertices for trivial indexing. Rejected vertices stay in
  // the buffer but no index references them — wasted memory, not wrong.
  const topOff = positions.length / 3;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      positions.push(xAt(i), topY[k], zAt(j));
      const t = max > min ? (heights[k] - min) / (max - min) : 0;
      pushColor(palette.surface(t));
    }
  }
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!cellKept[j * cw + i]) continue;
      const a = topOff + j * gw + i;
      const b = topOff + j * gw + i + 1;
      const c = topOff + (j + 1) * gw + i;
      const d = topOff + (j + 1) * gw + i + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  // ---------- 2. BOTTOM SURFACE ----------
  // Flat copy at y = 0, opposite winding (CW from above = -Y normal).
  const botOff = positions.length / 3;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      positions.push(xAt(i), 0, zAt(j));
      pushColor(palette.base);
    }
  }
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!cellKept[j * cw + i]) continue;
      const a = botOff + j * gw + i;
      const b = botOff + j * gw + i + 1;
      const c = botOff + (j + 1) * gw + i;
      const d = botOff + (j + 1) * gw + i + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // ---------- 3. SIDE WALLS ----------
  // For each kept cell, emit a vertical strip on each side whose neighbor
  // is rejected. Walking the cell's perimeter CCW (from above) gives the
  // outward normal automatically — verified per side in derivation below.
  //
  // For (kA, kB) walked along the top edge, the wall quad is:
  //   tA = (xA, topY[kA], zA), tB = (xB, topY[kB], zB)
  //   bA = (xA, 0,         zA), bB = (xB, 0,         zB)
  // Triangulate (tA, tB, bA), (tB, bB, bA). Outward normal of tri1:
  //   cross(tB - tA, bA - tA) = (dz·h, 0, -dx·h)
  // — which yields +Z when walking westward, -Z eastward, +X southward,
  // -X northward; matches the CCW perimeter walk.
  const emitWall = (kA: number, kB: number) => {
    const iA = kA % gw;
    const jA = (kA - iA) / gw;
    const iB = kB % gw;
    const jB = (kB - iB) / gw;
    const v0 = positions.length / 3;
    positions.push(xAt(iA), topY[kA], zAt(jA)); pushColor(palette.base);
    positions.push(xAt(iB), topY[kB], zAt(jB)); pushColor(palette.base);
    positions.push(xAt(iA), 0,        zAt(jA)); pushColor(palette.base);
    positions.push(xAt(iB), 0,        zAt(jB)); pushColor(palette.base);
    indices.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
  };

  const cellKeptAt = (i: number, j: number) =>
    i >= 0 && i < cw && j >= 0 && j < ch && cellKept[j * cw + i] === 1;

  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!cellKept[j * cw + i]) continue;
      // EAST side (outward +X): walk south→north on x = xAt(i+1).
      if (!cellKeptAt(i + 1, j)) {
        emitWall((j + 1) * gw + (i + 1), j * gw + (i + 1));
      }
      // NORTH side (outward +Z): walk east→west on z = zAt(j).
      if (!cellKeptAt(i, j - 1)) {
        emitWall(j * gw + (i + 1), j * gw + i);
      }
      // WEST side (outward -X): walk north→south on x = xAt(i).
      if (!cellKeptAt(i - 1, j)) {
        emitWall(j * gw + i, (j + 1) * gw + i);
      }
      // SOUTH side (outward -Z): walk west→east on z = zAt(j+1).
      if (!cellKeptAt(i, j + 1)) {
        emitWall((j + 1) * gw + i, (j + 1) * gw + (i + 1));
      }
    }
  }

  // ---------- Pack into typed arrays ----------
  const positionsArr = new Float32Array(positions);
  const colorsArr = new Float32Array(colors);
  const indicesArr = new Uint32Array(indices);
  const normals = new Float32Array(positionsArr.length);
  VertexData.ComputeNormals(positionsArr, indicesArr, normals, {
    useRightHandedSystem: true,
  });

  const vd = new VertexData();
  vd.positions = positionsArr;
  vd.indices = indicesArr;
  vd.normals = normals;
  vd.colors = colorsArr;

  return {
    vertexData: vd,
    inPerMeter,
    topYFn: (k) => topY[k],
  };
}

export interface KeptGround {
  /** The shape's mask: a cell is built only when all four corners pass. */
  inShape: (x: number, z: number) => boolean;
  /** A cut made through the built cells afterwards, such as a resort's outline. */
  inCut?: (x: number, z: number) => boolean;
}

/**
 * The lowest elevation the finished model shows: the minimum over every
 * built cell, or with a cut, over every built cell that has a corner
 * inside it. A cut through such a cell exposes ground between its
 * corners, never below the lowest of them. A cut that crosses a cell
 * without taking in a corner can leave lower ground, which the mesh
 * builders hold level at the base.
 */
export function lowestKeptElevation(
  data: ElevationResponse,
  gridWidthInches: number,
  gridHeightInches: number,
  kept: KeptGround,
): number {
  const { heights, width: gw, height: gh } = data;
  const xAt = (i: number) => -gridWidthInches / 2 + (i * gridWidthInches) / (gw - 1);
  const zAt = (j: number) => gridHeightInches / 2 - (j * gridHeightInches) / (gh - 1);
  const mask = (inside: (x: number, z: number) => boolean) => {
    const cells = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) cells[j * gw + i] = inside(xAt(i), zAt(j)) ? 1 : 0;
    }
    return cells;
  };
  const shape = mask(kept.inShape);
  const cut = kept.inCut ? mask(kept.inCut) : null;
  let lowest = Infinity;
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const corners = [j * gw + i, j * gw + i + 1, (j + 1) * gw + i, (j + 1) * gw + i + 1];
      if (!corners.every((k) => shape[k] === 1)) continue;
      if (cut && !corners.some((k) => cut[k] === 1)) continue;
      for (const k of corners) lowest = Math.min(lowest, heights[k]);
    }
  }
  return Number.isFinite(lowest) ? lowest : data.min;
}

// ---------- Default hypsometric palette ----------

const STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [63 / 255, 130 / 255, 78 / 255]],
  [0.35, [120 / 255, 140 / 255, 70 / 255]],
  [0.6, [135 / 255, 110 / 255, 80 / 255]],
  [0.85, [160 / 255, 160 / 255, 160 / 255]],
  [1.0, [248 / 255, 250 / 255, 252 / 255]],
];

export function hypsometric(t: number): [number, number, number] {
  const tt = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t0, c0] = STOPS[i - 1];
    const [t1, c1] = STOPS[i];
    if (tt <= t1) {
      const f = (tt - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
