// Geometry for the four selectable model shapes. The shape is inscribed
// in the bbox (and matching print canvas) — selecting a non-rectangle
// shape locks the bbox aspect so the inscribed figure fills the frame.
//
// Coordinates here are the model-plane (x, z) in inches with the origin
// at the model center: x ∈ [-W/2, +W/2], z ∈ [-H/2, +H/2]. The mesh
// builder converts these from / to the elevation grid.

export type Shape = "rectangle" | "circle" | "hexagon";

/** Flat-top regular hexagon: vertex-to-vertex W = 2R, flat-to-flat H = R√3. */
export const HEX_FLAT_TO_LONG = Math.sqrt(3) / 2; // ≈ 0.866

/** Whether the mesh builder needs to mask out grid cells outside the shape. */
export function shapeUsesMask(shape: Shape): boolean {
  return shape === "circle" || shape === "hexagon";
}

/** Whether the shape is meaningfully rotatable (a circle is not). */
export function shapeIsRotatable(shape: Shape): boolean {
  return shape !== "circle";
}

/**
 * Point-in-shape test in model-plane coords. W and H are the shape's
 * pre-rotation bounding-box width and height; `rotation` is in degrees
 * and rotates the shape (not the test point). The math is unit-agnostic
 * — the same routine serves both the mesh (inches) and the SVG overlay
 * (pixels).
 */
export function pointInShape(
  shape: Shape,
  x: number,
  z: number,
  W: number,
  H: number,
  rotation: number = 0,
): boolean {
  // Un-rotate the test point so we can test against the canonical
  // (axis-aligned) shape.
  const xRot = x;
  const zRot = z;
  let xt = xRot;
  let zt = zRot;
  if (rotation !== 0) {
    const a = (-rotation * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    xt = xRot * c - zRot * s;
    zt = xRot * s + zRot * c;
  }
  switch (shape) {
    case "rectangle":
      return Math.abs(xt) <= W / 2 && Math.abs(zt) <= H / 2;
    case "circle": {
      const r = W / 2; // circle is always W = H
      return xt * xt + zt * zt <= r * r;
    }
    case "hexagon": {
      // Flat-top hex with vertex-to-vertex = W, flat-to-flat = H = W√3/2.
      const R = W / 2;
      const ax = Math.abs(xt);
      const az = Math.abs(zt);
      if (ax > R) return false;
      if (az > (R * Math.sqrt(3)) / 2) return false;
      return ax + az / Math.sqrt(3) <= R;
    }
  }
}

/**
 * Vertices of the shape's outline in model-plane coords, CCW, rotated by
 * `rotation` degrees. Used by the map overlay to draw an SVG path.
 */
export function shapeOutline(
  shape: Shape,
  W: number,
  H: number,
  rotation: number = 0,
): Array<[number, number]> {
  const base: Array<[number, number]> = (() => {
    switch (shape) {
      case "rectangle":
        return [
          [-W / 2, -H / 2],
          [+W / 2, -H / 2],
          [+W / 2, +H / 2],
          [-W / 2, +H / 2],
        ];
      case "circle": {
        const r = W / 2;
        const n = 64;
        const out: Array<[number, number]> = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          out.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        return out;
      }
      case "hexagon": {
        const R = W / 2;
        const out: Array<[number, number]> = [];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          out.push([R * Math.cos(a), R * Math.sin(a)]);
        }
        return out;
      }
    }
  })();
  if (rotation === 0) return base;
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return base.map(([x, z]) => [x * c - z * s, x * s + z * c]);
}

/**
 * AABB of the rotated shape, returned as half-extents (half-width, half-height).
 * Used to derive the geographic bbox that bounds the rotated shape for
 * elevation sampling.
 */
export function shapeAABBHalf(
  shape: Shape,
  W: number,
  H: number,
  rotation: number = 0,
): [number, number] {
  if (shape === "circle") {
    const r = W / 2;
    return [r, r];
  }
  const outline = shapeOutline(shape, W, H, rotation);
  let halfW = 0;
  let halfH = 0;
  for (const [x, z] of outline) {
    halfW = Math.max(halfW, Math.abs(x));
    halfH = Math.max(halfH, Math.abs(z));
  }
  return [halfW, halfH];
}

/**
 * Convert a "diameter" value (the user-facing single-number size for
 * circle/hex) into the shape's pre-rotation (width, height). For
 * rectangle this isn't used.
 */
export function diameterToWH(shape: Shape, diameter: number): [number, number] {
  switch (shape) {
    case "circle":
      return [diameter, diameter];
    case "hexagon":
      return [diameter, diameter * HEX_FLAT_TO_LONG];
    case "rectangle":
      return [diameter, diameter];
  }
}
