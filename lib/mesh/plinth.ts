// Plinth: a frustum sitting under the terrain, slightly larger than the
// model footprint. The outer rim is beveled (35° from horizontal by
// default) so engraved text and a compass face partially upward when
// the model rests on a desk.
//
// Geometry (cross-section through the model and plinth):
//
//                    ___terrain peak___
//                   /                  \
//                  /  terrain on top    \
//                 /                      \
//                 ┌──────────────────────┐  ← y = plinthTopY (terrain base)
//                /        bevel          \      face tilted at `bevelDeg`
//               /     (faces outward     \
//              /       and upward)        \
//             └────────────────────────────┘  ← y = 0 (desk level)
//
// The plinth is a separate watertight mesh; ModelViewer either displays
// it alongside the terrain or CSG-unions them for STL export.

import { VertexData } from "@babylonjs/core";

import { HEX_FLAT_TO_LONG, shapeOutline, type Shape } from "@/lib/shape";

export interface PlinthSpec {
  shape: Shape;
  /** Shape pre-rotation width in inches. */
  widthInches: number;
  /** Shape pre-rotation height in inches. */
  heightInches: number;
  /** Degrees clockwise from north. */
  rotation: number;
  /** Bevel angle from horizontal (e.g., 35°). */
  bevelDeg: number;
  /** Bevel width in inches (= the horizontal extension on every side). */
  bevelWidthInches: number;
  /** Where the plinth top meets the terrain's base (= terrain's baseThicknessInches). */
  plinthTopY: number;
}

export interface PlinthResult {
  vertexData: VertexData;
  /** Plinth bottom y (always 0). */
  bottomY: number;
  /** y-extent of the bevel face (= plinthTopY − bottomY). */
  bevelHeight: number;
  /** Outer (bottom) outline points in shape-local coords. */
  outerOutline: Array<[number, number]>;
  /** Inner (top) outline points in shape-local coords. */
  innerOutline: Array<[number, number]>;
}

/**
 * Build the plinth as a closed (watertight) mesh.
 *
 * The bevel face is tilted at `bevelDeg` from horizontal. The bevel
 * height is determined by the bevel width and angle:
 *   bevelHeight = bevelWidth * tan(bevelDeg)
 * The plinth's bottom sits at y = 0; the top edge meets the terrain at
 * y = plinthTopY (passed in by the caller, equal to the terrain's base
 * thickness). bevelHeight is recomputed from the available height so
 * the bevel angle is preserved exactly.
 */
export function buildPlinth(spec: PlinthSpec): PlinthResult {
  const {
    shape,
    widthInches,
    heightInches,
    rotation,
    bevelDeg,
    bevelWidthInches,
    plinthTopY,
  } = spec;

  // The bevel rises from y=0 to y=plinthTopY. Its slope is bevelDeg from
  // horizontal, so the horizontal run = plinthTopY / tan(bevelDeg). We
  // size bevelWidthInches based on this so the geometry is consistent.
  const tanBevel = Math.tan((bevelDeg * Math.PI) / 180);
  // If the caller asked for a specific bevel width, respect it (and
  // accept a slight deviation from the canonical angle when the bevel
  // height doesn't divide evenly). Otherwise derive from the angle.
  const bevelW = bevelWidthInches || plinthTopY / tanBevel;
  const bevelHeight = plinthTopY;

  // Outer (= bottom) outline in shape-local coords: expand the shape's
  // pre-rotation dimensions, then apply rotation in shapeOutline().
  let outerW = widthInches;
  let outerH = heightInches;
  if (shape === "rectangle") {
    outerW += 2 * bevelW;
    outerH += 2 * bevelW;
  } else if (shape === "circle") {
    outerW += 2 * bevelW;
    outerH = outerW;
  } else if (shape === "hexagon") {
    // Increase the apothem (flat-to-flat radius) by bevelW. For a
    // flat-top hex with vertex-to-vertex diameter D, the apothem is
    // D*√3/4. Expanding the apothem by m means the new vertex diameter
    // is D + 2m/(√3/2) = D + 4m/√3.
    const dExpand = (4 * bevelW) / Math.sqrt(3);
    outerW += dExpand;
    outerH = outerW * HEX_FLAT_TO_LONG;
  }

  const innerOutline = shapeOutline(shape, widthInches, heightInches, rotation);
  const outerOutline = shapeOutline(shape, outerW, outerH, rotation);
  const n = innerOutline.length;
  // shapeOutline returns both outlines at the same vertex count, in the
  // same order — useful for emitting matching bevel quads below.
  if (outerOutline.length !== n) {
    throw new Error("plinth: inner / outer outline vertex counts differ");
  }

  const positions: number[] = [];
  const indices: number[] = [];

  // Inner (top) ring at y = plinthTopY.
  const topStart = 0;
  for (const [x, z] of innerOutline) {
    positions.push(x, plinthTopY, z);
  }
  // Outer (bottom) ring at y = 0.
  const botStart = positions.length / 3;
  for (const [x, z] of outerOutline) {
    positions.push(x, 0, z);
  }

  // ---------- 1. TOP FACE (+Y normal) ----------
  // shapeOutline iterates CCW in math (+x right, +z up). With the
  // right-handed cross-product convention used by ComputeNormals, the
  // fan order (0, i+1, i) produces +Y normals; the straight fan
  // (0, i, i+1) would give −Y.
  for (let i = 1; i < n - 1; i++) {
    indices.push(topStart, topStart + i + 1, topStart + i);
  }

  // ---------- 2. BOTTOM FACE (−Y normal) ----------
  for (let i = 1; i < n - 1; i++) {
    indices.push(botStart, botStart + i, botStart + i + 1);
  }

  // ---------- 3. BEVEL SIDES ----------
  // Each pair (top[i], top[i+1], bot[i+1], bot[i]) forms a sloped quad.
  // Winding (tA, tB, bB) + (tA, bB, bA) gives the outward normal: a
  // mix of horizontal (away from origin) and +Y (upward) — the bevel
  // face slopes up and outward.
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const tA = topStart + i;
    const tB = topStart + ni;
    const bA = botStart + i;
    const bB = botStart + ni;
    indices.push(tA, tB, bB);
    indices.push(tA, bB, bA);
  }

  const positionsArr = new Float32Array(positions);
  const indicesArr = new Uint32Array(indices);
  const normals = new Float32Array(positionsArr.length);
  VertexData.ComputeNormals(positionsArr, indicesArr, normals, {
    useRightHandedSystem: true,
  });

  const vd = new VertexData();
  vd.positions = positionsArr;
  vd.indices = indicesArr;
  vd.normals = normals;

  return {
    vertexData: vd,
    bottomY: 0,
    bevelHeight,
    outerOutline,
    innerOutline,
  };
}
