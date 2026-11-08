// Which way a ski area "faces": the side its base sits on. Every run and
// lift is a line from somewhere high to somewhere low, so the mean
// downhill direction, weighted by vertical drop, points from the
// mountain toward the base. A long flat cat track contributes almost
// nothing; a lift from the village to the summit contributes a lot.
//
// A bowl of runs fanning out in every direction has no front; the
// downhill vectors cancel and the result is null.

export type PlanePoint = [number, number];

export interface FrontSpec {
  /** Polylines in the model plane: x east, z north, any unit. */
  paths: PlanePoint[][];
  /** Surface height at a plane point, in any unit (only ratios matter). */
  heightAt: (x: number, z: number) => number;
  /** Half-extents of the sampled area; points outside are ignored. */
  halfWidth: number;
  halfHeight: number;
}

/**
 * Below this fraction of the total drop the downhill vectors mostly
 * cancel and no single side is the front.
 */
const MIN_AGREEMENT = 0.25;

/** Geographic bearing of the base side in degrees clockwise from north, or null. */
export function frontBearing(spec: FrontSpec): number | null {
  const { paths, heightAt, halfWidth, halfHeight } = spec;
  let sumX = 0;
  let sumZ = 0;
  let totalDrop = 0;

  for (const path of paths) {
    let top: PlanePoint | null = null;
    let bottom: PlanePoint | null = null;
    let topH = -Infinity;
    let bottomH = Infinity;
    for (const p of path) {
      if (Math.abs(p[0]) > halfWidth || Math.abs(p[1]) > halfHeight) continue;
      const h = heightAt(p[0], p[1]);
      if (h > topH) {
        topH = h;
        top = p;
      }
      if (h < bottomH) {
        bottomH = h;
        bottom = p;
      }
    }
    if (!top || !bottom) continue;
    const drop = topH - bottomH;
    const dx = bottom[0] - top[0];
    const dz = bottom[1] - top[1];
    const len = Math.hypot(dx, dz);
    if (drop <= 0 || len === 0) continue;
    sumX += (dx / len) * drop;
    sumZ += (dz / len) * drop;
    totalDrop += drop;
  }

  if (totalDrop === 0) return null;
  if (Math.hypot(sumX, sumZ) < MIN_AGREEMENT * totalDrop) return null;
  const deg = (Math.atan2(sumX, sumZ) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}
