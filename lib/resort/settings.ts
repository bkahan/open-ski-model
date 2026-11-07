import type { ColorSchemeSetting } from "./colors";

export interface ResortSettings {
  showRuns: boolean;
  showLifts: boolean;
  /** Printable minimum ribbon width; narrower runs are widened to this. */
  minRunWidthMm: number;
  colorScheme: ColorSchemeSetting;
}

export const MIN_RUN_WIDTH_MM = 0.4;
export const MAX_RUN_WIDTH_MM = 5;

export const DEFAULT_RESORT_SETTINGS: ResortSettings = {
  showRuns: true,
  showLifts: true,
  minRunWidthMm: 1.2,
  colorScheme: "auto",
};

export function clampRunWidth(mm: number): number {
  return Math.min(MAX_RUN_WIDTH_MM, Math.max(MIN_RUN_WIDTH_MM, mm));
}
