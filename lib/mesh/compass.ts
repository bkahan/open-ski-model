// Compass arrow that points to true world-north regardless of the
// model's rotation. The geometry is a filled "N → ↑" indicator: a
// triangle arrow with an "N" letter at its tip. Engraved into the
// plinth bevel by subtractive CSG.
//
// Coordinate convention matches buildTextMesh: shape lives in the X-Z
// plane (Y is the extrude axis). Origin is at the compass center. The
// arrow points to (sin θ, cos θ) in shape-local coords, where θ is the
// MODEL's rotation in degrees — so after the model rotates with the
// terrain, the arrow still points at true world-north.

import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import earcut from "earcut";

export interface CompassMeshOptions {
  /** Outer diameter of the arrow (inches). */
  size: number;
  /** Depth to extrude into the bevel (inches). */
  depth: number;
  /** Model rotation in degrees (CCW). The arrow counter-rotates by this. */
  modelRotationDeg: number;
  scene: Scene;
  name?: string;
}

/**
 * Build a filled arrow polygon pointing to world-north in the shape's
 * local frame. The arrow is a slightly-elongated triangle so it reads
 * directionally even at small sizes.
 *
 *      ▲    ← tip (points at world north)
 *     ▲▲
 *    ▲  ▲
 *   ▲────▲  ← base
 */
export function buildCompassArrow(opts: CompassMeshOptions): Mesh | null {
  const { size, depth, modelRotationDeg, scene } = opts;
  // Build the arrow in a "north-up" canonical frame, then rotate by
  // -modelRotation so it points to world-north on the model.
  const r = size / 2;
  // Arrow: tip at (0, r), base at (±0.6r, -0.3r). Slight notch on the
  // back so it reads as an arrowhead rather than a triangle.
  const canonical: Array<[number, number]> = [
    [0, r],
    [0.55 * r, -0.25 * r],
    [0.2 * r, -0.1 * r],
    [0.2 * r, -0.85 * r],
    [-0.2 * r, -0.85 * r],
    [-0.2 * r, -0.1 * r],
    [-0.55 * r, -0.25 * r],
  ];
  // Counter-rotate so the in-model "north" matches world-north.
  const θ = (-modelRotationDeg * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  const rotated = canonical.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const shape = rotated.map(([x, y]) => new Vector3(x, 0, y));
  try {
    // Single-sided so CSG.subtract sees a watertight volume.
    const m = MeshBuilder.ExtrudePolygon(
      opts.name ?? "compass",
      { shape, depth },
      scene,
      earcut,
    );
    return m;
  } catch (err) {
    console.warn(`[compass] failed: ${(err as Error).message}`);
    return null;
  }
}
