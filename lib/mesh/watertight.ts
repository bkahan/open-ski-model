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

export interface WatertightSpec {
  bbox: Bbox;
  data: ElevationResponse;
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  verticalExaggeration: number;
}

export interface Palette {
  /** Returns [r,g,b] in 0..1 given a normalized elevation 0..1. */
  surface: (t: number) => [number, number, number];
  /** Color for side walls + base. */
  base: [number, number, number];
}

const DEFAULT_PALETTE: Palette = {
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
  const topY = new Float32Array(gw * gh);
  for (let k = 0; k < gw * gh; k++) {
    topY[k] = base + (heights[k] - min) * inPerMeter * vx;
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

  // ---------- 2. BOTTOM (4 corners → 2 triangles) ----------
  const SW = positions.length / 3;
  positions.push(-W / 2, 0, -H / 2); pushColor(palette.base);
  const SE = positions.length / 3;
  positions.push(+W / 2, 0, -H / 2); pushColor(palette.base);
  const NW = positions.length / 3;
  positions.push(-W / 2, 0, +H / 2); pushColor(palette.base);
  const NE = positions.length / 3;
  positions.push(+W / 2, 0, +H / 2); pushColor(palette.base);
  // CW from above → -Y normal (so the bottom faces down).
  indices.push(SW, SE, NE, SW, NE, NW);

  // ---------- 3. SIDE WALLS ----------
  // Helper: build one wall strip. `topRow` enumerates (k, x, z) pairs for
  // the top edge in order; orient = whether to flip winding for the
  // outward normal.
  type WallVertex = { k: number; x: number; z: number };
  const buildWall = (
    topRow: WallVertex[],
    outwardFlip: boolean,
    /** indices in the master arrays of the bottom-edge endpoints */
    leftBot: number,
    rightBot: number,
  ) => {
    const wallStart = positions.length / 3;

    // Top vertices (duplicated from the top surface for the sharp crease)
    for (const v of topRow) {
      positions.push(v.x, topY[v.k], v.z);
      pushColor(palette.base);
    }
    // Bottom vertices — except for the two corners which we share with the
    // bottom face. We push interior bottom vertices into our own block
    // and refer to leftBot / rightBot for the corners.
    const n = topRow.length;
    const interiorBotStart = positions.length / 3;
    for (let i = 1; i < n - 1; i++) {
      positions.push(topRow[i].x, 0, topRow[i].z);
      pushColor(palette.base);
    }
    const botIndex = (i: number) => {
      if (i === 0) return leftBot;
      if (i === n - 1) return rightBot;
      return interiorBotStart + (i - 1);
    };

    for (let i = 0; i < n - 1; i++) {
      const V0 = wallStart + i;          // top[i]
      const V1 = wallStart + i + 1;      // top[i+1]
      const V2 = botIndex(i);            // bot[i]
      const V3 = botIndex(i + 1);        // bot[i+1]
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
    NW, NE,
  );
  // SOUTH wall — j=gh-1 row, z = -H/2, outward normal = -Z, FLIP.
  buildWall(
    Array.from({ length: gw }, (_, i) => ({
      k: (gh - 1) * gw + i,
      x: xAt(i),
      z: -H / 2,
    })),
    true,
    SW, SE,
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
    NW, SW,
  );
  // EAST wall — i=gw-1 column, x = +W/2, outward normal = +X, FLIP.
  buildWall(
    Array.from({ length: gh }, (_, j) => ({
      k: j * gw + (gw - 1),
      x: +W / 2,
      z: zAt(j),
    })),
    false,
    NE, SE,
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
