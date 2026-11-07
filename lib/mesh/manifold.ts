// Boolean geometry via Manifold (WASM). Replaces Babylon's BSP-tree CSG,
// which needed minutes and gigabytes to cut text into a 130k-triangle
// terrain. Manifold does the same in well under a second and its output
// is watertight by construction.
//
// Conventions: coordinates are the viewer's model-plane inches, triangles
// wound CCW as seen from outside (the same right-handed convention the
// mesh builders already use). Manifold objects live in WASM memory and
// must be `delete()`d; `using`-style helpers below keep that contained.

import { VertexData } from "@babylonjs/core";
import type { Manifold, ManifoldToplevel, Vec2 } from "manifold-3d";

let toplevel: Promise<ManifoldToplevel> | null = null;

/** Served from public/ by scripts/copy-manifold-wasm.mjs on install and build. */
const WASM_URL = "/manifold.wasm";

export async function loadManifold(): Promise<ManifoldToplevel> {
  if (!toplevel) {
    toplevel = import("manifold-3d")
      .then(async ({ default: Module }) => {
        const wasm = await Module({ locateFile: () => WASM_URL });
        wasm.setup();
        return wasm;
      })
      .catch((err: unknown) => {
        // Don't pin a failed load; the next call retries.
        toplevel = null;
        throw err;
      });
  }
  return toplevel;
}

export interface TriMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/**
 * Build a Manifold from a triangle mesh. Coincident vertices (the mesh
 * builders duplicate them at creases) are merged by position first.
 */
export function manifoldFromMesh(m: ManifoldToplevel, mesh: TriMesh): Manifold {
  const gl = new m.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(mesh.positions),
    triVerts: Uint32Array.from(mesh.indices),
  });
  gl.merge();
  const solid = new m.Manifold(gl);
  const status = solid.status();
  if (status !== "NoError") {
    solid.delete();
    throw new Error(`mesh is not a valid solid: ${status}`);
  }
  return solid;
}

export type Rgb = [number, number, number];

/** Faces meeting at more than this angle keep separate normals (a crease). */
const CREASE_COS = Math.cos((60 * Math.PI) / 180);

/**
 * Convert a Manifold back to Babylon VertexData. Manifold merges every
 * coincident vertex, so plain smooth normals would blur the crease where
 * the terrain meets its walls. Each triangle gets its own three vertices,
 * with normals averaged only across neighbors within the crease angle.
 */
/** Per-vertex color from position and the (crease-aware) normal. */
export type ColorAt = (x: number, y: number, z: number, ny: number) => Rgb;

export function vertexDataFromManifold(solid: Manifold, colorAt?: ColorAt): VertexData {
  const gl = solid.getMesh();
  const src = gl.vertProperties;
  const tri = gl.triVerts;
  const numProp = gl.numProp;
  const triCount = tri.length / 3;

  const faceNormals = new Float32Array(triCount * 3);
  const facesAtVertex = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    const ax = src[a * numProp], ay = src[a * numProp + 1], az = src[a * numProp + 2];
    const bx = src[b * numProp], by = src[b * numProp + 1], bz = src[b * numProp + 2];
    const cx = src[c * numProp], cy = src[c * numProp + 1], cz = src[c * numProp + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    faceNormals[t * 3] = nx;
    faceNormals[t * 3 + 1] = ny;
    faceNormals[t * 3 + 2] = nz;
    for (const v of [a, b, c]) {
      const list = facesAtVertex.get(v);
      if (list) list.push(t);
      else facesAtVertex.set(v, [t]);
    }
  }

  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const fnx = faceNormals[t * 3], fny = faceNormals[t * 3 + 1], fnz = faceNormals[t * 3 + 2];
    for (let corner = 0; corner < 3; corner++) {
      const v = tri[t * 3 + corner];
      const out = t * 9 + corner * 3;
      positions[out] = src[v * numProp];
      positions[out + 1] = src[v * numProp + 1];
      positions[out + 2] = src[v * numProp + 2];
      let sx = 0, sy = 0, sz = 0;
      for (const f of facesAtVertex.get(v) ?? []) {
        const ox = faceNormals[f * 3], oy = faceNormals[f * 3 + 1], oz = faceNormals[f * 3 + 2];
        if (ox * fnx + oy * fny + oz * fnz >= CREASE_COS) {
          sx += ox;
          sy += oy;
          sz += oz;
        }
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      normals[out] = sx / len;
      normals[out + 1] = sy / len;
      normals[out + 2] = sz / len;
      indices[t * 3 + corner] = t * 3 + corner;
    }
  }

  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  if (colorAt) {
    const n = positions.length / 3;
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = colorAt(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], normals[i * 3 + 1]);
      colors[i * 4] = c[0];
      colors[i * 4 + 1] = c[1];
      colors[i * 4 + 2] = c[2];
      colors[i * 4 + 3] = 1;
    }
    vd.colors = colors;
  }
  return vd;
}

/**
 * Extrude closed 2D contours (x, y) along +Z from 0 to `depth`. Holes and
 * overlaps are resolved by the non-zero fill rule, so font outlines can
 * be passed straight through.
 */
export function extrudeContours(
  m: ManifoldToplevel,
  contours: Vec2[][],
  depth: number,
): Manifold {
  const section = new m.CrossSection(contours, "NonZero");
  try {
    return section.extrude(depth);
  } finally {
    section.delete();
  }
}

/** Run `fn` with the solids, then free them, whatever happens. */
export function withSolids<T>(solids: Manifold[], fn: () => T): T {
  try {
    return fn();
  } finally {
    for (const s of solids) s.delete();
  }
}
