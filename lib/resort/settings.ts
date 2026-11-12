import type { ColorSchemeSetting } from "./colors";

export interface ResortSettings {
  showRuns: boolean;
  showLifts: boolean;
  /**
   * The Resort shape also takes untagged runs that only join the ski
   * area's further out, like Sugarloaf's Burnt Mountain (resortLines).
   */
  followConnected: boolean;
  /** Printable minimum line width; narrower runs are widened to this. */
  minRunWidthMm: number;
  colorScheme: ColorSchemeSetting;
}

export const MIN_RUN_WIDTH_MM = 0.4;
export const MAX_RUN_WIDTH_MM = 5;

export const DEFAULT_RESORT_SETTINGS: ResortSettings = {
  showRuns: true,
  showLifts: true,
  followConnected: false,
  minRunWidthMm: 1.2,
  colorScheme: "auto",
};

export function clampRunWidth(mm: number): number {
  return Math.min(MAX_RUN_WIDTH_MM, Math.max(MIN_RUN_WIDTH_MM, mm));
}
