// How big the model prints. Either the size is set and the map scale
// follows from the ground covered, or the scale is set and the size
// follows. Also sets the vertical scale so every resort stands about as
// tall on the print, whatever its real relief.
//
// The panel's size and the frame on the map are a "layout": together they
// fix what ground is covered and its proportions, and every frame edit
// works on them. printFrame turns a layout into the frame the model is
// actually built in.

export const DEFAULT_RELIEF_INCHES = 0.75;
export const MIN_RELIEF_INCHES = 0.25;
export const MAX_RELIEF_INCHES = 4;
export const MIN_COVERAGE_METERS = 500;
export const MAX_COVERAGE_METERS = 50_000;

const MIN_EXAGGERATION = 0.5;
const MAX_EXAGGERATION = 8;

const METERS_PER_INCH = 0.0254;

/** How the print's size is decided. `denominator` is the N of 1 : N. */
export type Sizing = { mode: "size" } | { mode: "scale"; denominator: number };

export const SCALE_PRESETS: readonly number[] = [10_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000];
export const MIN_SCALE_DENOMINATOR = 1_000;
export const MAX_SCALE_DENOMINATOR = 500_000;
/**
 * The longest side a model is built at. A set scale has no bed to stop
 * at (large prints are meant to be cut into tiles), but a frame of whole
 * mountain ranges at 1 : 1,000 is a typo, not a print.
 */
export const MAX_PRINT_INCHES = 100;

export function clampScaleDenominator(denominator: number): number {
  if (!Number.isFinite(denominator)) return MIN_SCALE_DENOMINATOR;
  return Math.min(MAX_SCALE_DENOMINATOR, Math.max(MIN_SCALE_DENOMINATOR, Math.round(denominator)));
}

/**
 * The N a person typed for 1 : N, clamped to the range: "25,000",
 * "25 000", "1:25000" and "25k" all read as 25000. Null for anything
 * that isn't a scale.
 */
export function parseScaleDenominator(text: string): number | null {
  const match = /^(?:1:)?(\d+(?:\.\d+)?)(k?)$/i.exec(text.replace(/[,\s]/g, ""));
  if (!match) return null;
  const typed = Number(match[1]) * (match[2] ? 1000 : 1);
  return typed > 0 ? clampScaleDenominator(typed) : null;
}

/** The N of 1 : N for a map scale in meters of ground per inch of print. */
export function denominatorForMetersPerInch(metersPerInch: number): number {
  return metersPerInch / METERS_PER_INCH;
}

export interface PrintSize {
  widthInches: number;
  heightInches: number;
}

export interface FittedFrame extends PrintSize {
  metersPerInch: number;
}

export interface PrintLayout {
  /** The size in the panel. For a resort's outline, the mountain's longest side, square. */
  size: PrintSize;
  /** Ground the frame on the map covers, per inch of `size`. */
  metersPerInch: number;
  sizing: Sizing;
  /**
   * For a resort's outline only: the outline's longest side as a share of
   * the side of the frame it is traced in. The size that is set or read
   * is the mountain's, and the frame is that much bigger.
   */
  outlineShare: number | null;
}

export interface PrintFrame extends FittedFrame {
  /** The size as the panel states it: the frame's, or the mountain's for a resort's outline. */
  stated: PrintSize;
}

/**
 * The frame a layout is built in. With a set size the frame is the
 * layout's (a resort's is enlarged so the mountain, not its frame, comes
 * out at that size). With a set scale the ground stays as laid out and
 * the frame is however big that ground is at 1 : N.
 */
export function printFrame(layout: PrintLayout): PrintFrame {
  const { size, sizing } = layout;
  const share = layout.outlineShare ?? 1;
  const grow =
    sizing.mode === "size" ? 1 / share : layout.metersPerInch / (sizing.denominator * METERS_PER_INCH);
  const widthInches = size.widthInches * grow;
  const heightInches = size.heightInches * grow;
  return {
    widthInches,
    heightInches,
    metersPerInch: layout.metersPerInch / grow,
    stated: { widthInches: widthInches * share, heightInches: heightInches * share },
  };
}

function longestSide(size: PrintSize): number {
  return Math.max(size.widthInches, size.heightInches);
}

/** Over MAX_PRINT_INCHES, or not a size at all: nothing to build either way. */
export function tooLargeToBuild(frame: PrintSize): boolean {
  return !(longestSide(frame) <= MAX_PRINT_INCHES);
}

/**
 * A frame drag reports the new shape in inches at the current map scale.
 * Convert that to the same ground area at the existing print size: the
 * longest side stays put and the map scale absorbs the change. Returns
 * null for coverage out of range, so the frame stops instead of sliding
 * away from the cursor.
 */
export function fitDragToPrint(
  dragged: PrintSize,
  print: PrintSize,
  metersPerInch: number,
): FittedFrame | null {
  const coverageMeters = longestSide(dragged) * metersPerInch;
  if (coverageMeters < MIN_COVERAGE_METERS || coverageMeters > MAX_COVERAGE_METERS) {
    return null;
  }
  const target = longestSide(print);
  const fit = target / longestSide(dragged);
  return {
    widthInches: dragged.widthInches * fit,
    heightInches: dragged.heightInches * fit,
    metersPerInch: metersPerInch / fit,
  };
}

/** The map scale that keeps the same ground coverage on a resized print. */
export function scaleForResizedPrint(
  previous: PrintSize,
  next: PrintSize,
  metersPerInch: number,
): number {
  return (metersPerInch * longestSide(previous)) / longestSide(next);
}

/** Model height that keeps its proportions on a resized print. */
export function reliefForResizedPrint(
  previous: PrintSize,
  next: PrintSize,
  reliefInches: number,
): number {
  return (reliefInches * longestSide(next)) / longestSide(previous);
}

/**
 * Model height after the set scale changes from 1 : `previous` to
 * 1 : `next`: it grows and shrinks with the print, so the vertical
 * exaggeration stays what it was. Not held to the slider's range, as a
 * resized print's isn't: a scale tried and put back returns the height.
 */
export function reliefForRescaledPrint(reliefInches: number, previous: number, next: number): number {
  return (reliefInches * previous) / next;
}

/** Exaggeration that makes the terrain's relief print at `reliefInches`. */
export function exaggerationForRelief(
  reliefInches: number,
  reliefMeters: number,
  inchesPerMeter: number,
): number {
  const trueScaleInches = reliefMeters * inchesPerMeter;
  if (!(trueScaleInches > 0)) return 1;
  return Math.min(
    MAX_EXAGGERATION,
    Math.max(MIN_EXAGGERATION, reliefInches / trueScaleInches),
  );
}
