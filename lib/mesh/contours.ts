// Build contour lines for a height grid using marching squares.
//
// Mental model: pick N evenly-spaced iso-elevation values. For each one,
// walk every cell in the grid. The four corners are each either above or
// below the iso-value, giving 2^4 = 16 cases. In each case, linearly
// interpolate where the iso-line crosses the cell edges and emit those
// line segments.
//
// The output is positions + paired indices suitable for a Babylon LinesMesh.

import { VertexData } from "@babylonjs/core";

import type { ElevationResponse } from "@/lib/elevation/types";

export interface ContourSpec {
  data: ElevationResponse;
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  /** Elevation that sits at the base thickness; the grid's minimum when unset. */
  floorElevation?: number;
  inPerMeter: number;
  verticalExaggeration: number;
  /** Number of contour intervals to render. */
  count: number;
  /** Small Y-offset to lift the lines just above the surface so they
   *  don't z-fight with the terrain. In inches. */
  lift: number;
  /**
   * Optional per-cell mask. If set, the contour pass skips cells where
   * `cellKept(i, j)` returns false — matches the staircase boundary used
   * by `buildShapedWatertight` so contour lines don't escape the shape.
   */
  cellKept?: (i: number, j: number) => boolean;
}

/**
 * Returns { positions, indices } where indices are pairs (lines).
 * Pass these into a `LinesMesh` via `MeshBuilder.CreateLineSystem` or by
 * directly applying as VertexData with topology = lines.
 */
export function buildContourLines(spec: ContourSpec): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const {
    data,
    widthInches: W,
    heightInches: H,
    baseThicknessInches: base,
    inPerMeter,
    verticalExaggeration: vx,
    count,
    lift,
    cellKept,
  } = spec;
  const { heights, width: gw, height: gh, min, max } = data;

  // Inches above the base for a given real-world elevation.
  const floor = spec.floorElevation ?? min;
  const elevToY = (e: number) => base + Math.max(0, e - floor) * inPerMeter * vx + lift;
  const xAt = (i: number) => -W / 2 + (i * W) / (gw - 1);
  const zAt = (j: number) => H / 2 - (j * H) / (gh - 1);

  const positions: number[] = [];
  const indices: number[] = [];

  for (let c = 1; c <= count; c++) {
    const t = c / (count + 1); // skip the very top and bottom
    const elev = min + t * (max - min);
    const y = elevToY(elev);

    for (let j = 0; j < gh - 1; j++) {
      const z0 = zAt(j);
      const z1 = zAt(j + 1);
      for (let i = 0; i < gw - 1; i++) {
        if (cellKept && !cellKept(i, j)) continue;
        const h00 = heights[j * gw + i];
        const h10 = heights[j * gw + i + 1];
        const h11 = heights[(j + 1) * gw + i + 1];
        const h01 = heights[(j + 1) * gw + i];
        const x0 = xAt(i);
        const x1 = xAt(i + 1);

        // 4-bit case: each corner contributes 1 if above the iso-value.
        // Bit assignment: 1=h00 (NW), 2=h10 (NE), 4=h11 (SE), 8=h01 (SW).
        const code =
          (h00 > elev ? 1 : 0) |
          (h10 > elev ? 2 : 0) |
          (h11 > elev ? 4 : 0) |
          (h01 > elev ? 8 : 0);
        if (code === 0 || code === 15) continue;

        // Edge interpolation: parametric position where elev crosses.
        // top edge runs h00 → h10 along the x axis at z0.
        const top = (): [number, number, number] => {
          const f = (elev - h00) / (h10 - h00);
          return [x0 + f * (x1 - x0), y, z0];
        };
        const right = (): [number, number, number] => {
          const f = (elev - h10) / (h11 - h10);
          return [x1, y, z0 + f * (z1 - z0)];
        };
        const bottom = (): [number, number, number] => {
          const f = (elev - h01) / (h11 - h01);
          return [x0 + f * (x1 - x0), y, z1];
        };
        const left = (): [number, number, number] => {
          const f = (elev - h00) / (h01 - h00);
          return [x0, y, z0 + f * (z1 - z0)];
        };

        // For each case, draw line segments between the edges the iso-line
        // crosses. Cases 5 and 10 are saddles (ambiguous) — we just draw
        // both possibilities; the result is visually fine for elevation.
        const pushLine = (
          p: [number, number, number],
          q: [number, number, number],
        ) => {
          const aIdx = positions.length / 3;
          positions.push(p[0], p[1], p[2]);
          positions.push(q[0], q[1], q[2]);
          indices.push(aIdx, aIdx + 1);
        };

        switch (code) {
          case 1:
          case 14:
            pushLine(left(), top());
            break;
          case 2:
          case 13:
            pushLine(top(), right());
            break;
          case 3:
          case 12:
            pushLine(left(), right());
            break;
          case 4:
          case 11:
            pushLine(right(), bottom());
            break;
          case 5:
            pushLine(left(), top());
            pushLine(right(), bottom());
            break;
          case 6:
          case 9:
            pushLine(top(), bottom());
            break;
          case 7:
          case 8:
            pushLine(left(), bottom());
            break;
          case 10:
            pushLine(left(), bottom());
            pushLine(top(), right());
            break;
          default:
            break;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/** Apply contour data to a LinesMesh-bound VertexData. */
export function contoursToVertexData(c: {
  positions: Float32Array;
  indices: Uint32Array;
}): VertexData {
  const vd = new VertexData();
  vd.positions = c.positions;
  vd.indices = c.indices;
  return vd;
}
