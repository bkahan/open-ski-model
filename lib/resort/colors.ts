// Trail-marking color conventions. OSM stores difficulty, not color, and
// the two main systems disagree: North America reads green / blue / black,
// Europe reads blue / red / black. "auto" picks by longitude.

import type { Bbox } from "@/lib/types";
import type { LiftType, RunConvention, RunDifficulty } from "./types";

export type ColorScheme = "na" | "eu";
export type ColorSchemeSetting = "auto" | ColorScheme;

export const COLOR_SCHEME_SETTINGS: readonly ColorSchemeSetting[] = ["auto", "na", "eu"];

export function isColorSchemeSetting(raw: string): raw is ColorSchemeSetting {
  return (COLOR_SCHEME_SETTINGS as readonly string[]).includes(raw);
}

export type Rgb = [number, number, number];

export interface RunColor {
  /** CSS hex for the map. */
  hex: string;
  /** 0..1 RGB for the viewer. */
  rgb: Rgb;
  /** Human-readable name used to group runs into print colors later. */
  name: string;
}

const GREEN: RunColor = { hex: "#1f9d55", rgb: [0.12, 0.62, 0.33], name: "green" };
const BLUE: RunColor = { hex: "#2563eb", rgb: [0.15, 0.39, 0.92], name: "blue" };
const RED: RunColor = { hex: "#dc2626", rgb: [0.86, 0.15, 0.15], name: "red" };
const BLACK: RunColor = { hex: "#111827", rgb: [0.07, 0.09, 0.15], name: "black" };
const ORANGE: RunColor = { hex: "#f97316", rgb: [0.98, 0.45, 0.09], name: "orange" };
const GRAY: RunColor = { hex: "#9ca3af", rgb: [0.61, 0.64, 0.69], name: "gray" };

const NA: Record<RunDifficulty, RunColor> = {
  novice: GREEN,
  easy: GREEN,
  intermediate: BLUE,
  advanced: BLACK,
  expert: BLACK,
  freeride: BLACK,
  extreme: BLACK,
  unknown: GRAY,
};

const EU: Record<RunDifficulty, RunColor> = {
  novice: GREEN,
  easy: BLUE,
  intermediate: RED,
  advanced: BLACK,
  expert: BLACK,
  freeride: ORANGE,
  extreme: ORANGE,
  unknown: GRAY,
};

export const LIFT_COLOR: RunColor = { hex: "#4b5563", rgb: [0.29, 0.33, 0.39], name: "lift" };

export function runColor(difficulty: RunDifficulty, scheme: ColorScheme): RunColor {
  return (scheme === "na" ? NA : EU)[difficulty];
}

export function liftColor(_type: LiftType): RunColor {
  return LIFT_COLOR;
}

/** The Americas use the green/blue/black system; everywhere else, blue/red/black. */
export function colorSchemeForBbox(bbox: Bbox): ColorScheme {
  const lng = (bbox[0] + bbox[2]) / 2;
  return lng < -30 ? "na" : "eu";
}

/** Japan marks trails like Europe (blue/red/black). */
export function colorSchemeForConvention(convention: RunConvention): ColorScheme {
  return convention === "north_america" ? "na" : "eu";
}

/**
 * "auto" prefers the convention the data was tagged under, and falls back
 * to the hemisphere when there are no runs to tell from.
 */
export function resolveColorScheme(
  setting: ColorSchemeSetting,
  bbox: Bbox,
  convention: RunConvention | null = null,
): ColorScheme {
  if (setting !== "auto") return setting;
  return convention ? colorSchemeForConvention(convention) : colorSchemeForBbox(bbox);
}
