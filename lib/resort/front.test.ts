import { describe, expect, it } from "vitest";

import { frontBearing, type PlanePoint } from "./front";

// A peak at the origin; height falls off with distance.
const peak = (x: number, z: number) => 1000 - Math.hypot(x, z);
const bounds = { halfWidth: 10, halfHeight: 10 };

const line = (...pts: PlanePoint[]): PlanePoint[] => pts;

describe("frontBearing", () => {
  it("points from the summit toward the base", () => {
    // Runs down the east side, drawn in either direction.
    const paths = [line([0, 0], [4, 1]), line([5, -1], [1, 0]), line([0, 1], [3, 3])];
    const bearing = frontBearing({ paths, heightAt: peak, ...bounds })!;
    expect(bearing).toBeGreaterThan(45);
    expect(bearing).toBeLessThan(135);
  });

  it("weights by drop, so a flat traverse barely counts", () => {
    const paths = [
      line([0, 0], [0, -6]), // long run south, 6 of drop
      line([3, 0], [3.2, 4]), // traverse-ish to the north, ~1 of drop
    ];
    const bearing = frontBearing({ paths, heightAt: peak, ...bounds })!;
    expect(Math.abs(bearing - 180)).toBeLessThan(20);
  });

  it("uses the high and low points along a run, not its ends", () => {
    // Starts and ends low, crosses the summit in the middle.
    const paths = [line([-4, 0], [0, 0], [6, 0])];
    const bearing = frontBearing({ paths, heightAt: peak, ...bounds })!;
    expect(bearing).toBeCloseTo(90, 5);
  });

  it("ignores points outside the sampled area", () => {
    const paths = [line([0, 0], [0, -30]), line([0, 0], [3, 0])];
    const bearing = frontBearing({ paths, heightAt: peak, ...bounds })!;
    expect(bearing).toBeCloseTo(90, 5);
  });

  it("returns null for a bowl with no front, and with no runs", () => {
    const bowl = [line([0, 0], [5, 0]), line([0, 0], [-5, 0]), line([0, 0], [0, 5]), line([0, 0], [0, -5])];
    expect(frontBearing({ paths: bowl, heightAt: peak, ...bounds })).toBeNull();
    expect(frontBearing({ paths: [], heightAt: peak, ...bounds })).toBeNull();
  });
});
