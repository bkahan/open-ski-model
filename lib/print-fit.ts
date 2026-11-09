// Keeps the print a fixed physical size while the frame on the map changes
// what it covers, and sets the vertical scale so every resort stands about
// as tall on the print, whatever its real relief.

export const DEFAULT_RELIEF_INCHES = 1.25;
export const MIN_COVERAGE_METERS = 500;
export const MAX_COVERAGE_METERS = 50_000;

const MIN_EXAGGERATION = 0.5;
const MAX_EXAGGERATION = 8;

export interface PrintSize {
  widthInches: number;
  heightInches: number;
}

export interface FittedFrame extends PrintSize {
  metersPerInch: number;
}

function longestSide(size: PrintSize): number {
  return Math.max(size.widthInches, size.heightInches);
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
