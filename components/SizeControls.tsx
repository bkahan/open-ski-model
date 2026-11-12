"use client";

// Print and coverage controls.
//
// Mental model:
//   - "Print size" is the model's physical dimensions in inches. It stays
//     put while the frame is dragged on the map.
//   - "Real-world coverage" is the shape's footprint on the ground in km.
//   - "Model height" is how tall the terrain's relief prints; the vertical
//     exaggeration follows from it and each resort's real relief.
//   - The aspect-lock toggle ties width to height for the print.
//   - For circle / hexagon, the print is described by a single diameter
//     (since aspect is fixed by the shape).
//   - The Resort shape has one size too, the mountain's longest side,
//     and its coverage is read-only: the ground is the resort's.
//   - "Set scale" turns the first two around: the scale is typed in and
//     the print comes out however big the covered ground is at it.

import { bboxWidthMeters } from "@/lib/bbox";
import {
  MAX_PRINT_INCHES,
  MAX_RELIEF_INCHES,
  MAX_SCALE_DENOMINATOR,
  MIN_RELIEF_INCHES,
  MIN_SCALE_DENOMINATOR,
  SCALE_PRESETS,
  denominatorForMetersPerInch,
  parseScaleDenominator,
  tooLargeToBuild,
  type PrintFrame,
  type Sizing,
} from "@/lib/print-fit";
import {
  HEX_FLAT_TO_LONG,
  shapeAABBHalf,
  type Shape,
} from "@/lib/shape";
import type { Bbox } from "@/lib/types";

const MM_PER_INCH = 25.4;
/** The common bed a print is checked against until printers have profiles here. */
const BED_MM = 256;

export interface SizeState {
  /** Shape's pre-rotation width in inches. */
  widthInches: number;
  /** Shape's pre-rotation height in inches. */
  heightInches: number;
  baseThicknessInches: number;
  /** Base-to-peak height of the terrain on the print, in inches. */
  reliefInches: number;
  /** When true, the rectangle's height is forced equal to its width. */
  aspectLocked: boolean;
}

interface Props {
  size: SizeState;
  shape: Shape;
  /** The footprint is a resort's outline in a square frame fitted to it. */
  resortMode: boolean;
  rotation: number;
  onChange: (next: SizeState) => void;
  sizing: Sizing;
  /** Switch between setting the size and setting the scale. */
  onSizingModeChange: (mode: Sizing["mode"]) => void;
  /** A new N for 1 : N. */
  onScaleChange: (denominator: number) => void;
  /** The frame the model is built in, and the size it is stated at. */
  frame: PrintFrame | null;
  bbox: Bbox | null;
  /** Exaggeration the current model height works out to, once terrain is loaded. */
  exaggeration: number | null;
  /** Sets the SHAPE's real-world width in meters (not the bbox AABB). */
  onShapeWidthMetersChange: (widthMeters: number) => void;
}

export default function SizeControls({
  size,
  shape,
  resortMode,
  rotation,
  onChange,
  sizing,
  onSizingModeChange,
  onScaleChange,
  frame,
  bbox,
  exaggeration,
  onShapeWidthMetersChange,
}: Props) {
  // The bbox is the AABB of the rotated shape. Back out the shape's own
  // width / height in meters to show real-world coverage in terms users
  // can act on (drag handles change the shape, not the AABB).
  const aabbHalfWIn = shapeAABBHalf(
    shape,
    size.widthInches,
    size.heightInches,
    rotation,
  )[0];
  const metersPerInch = bbox
    ? bboxWidthMeters(bbox) / (2 * aabbHalfWIn)
    : 0;
  const shapeWidthKm = (size.widthInches * metersPerInch) / 1000;
  const shapeHeightKm = (size.heightInches * metersPerInch) / 1000;
  // The model's own scale: the frame it is built in, not the panel's size.
  const scaleDenominator = frame ? Math.round(denominatorForMetersPerInch(frame.metersPerInch)) : 0;
  const scaleSet = sizing.mode === "scale";
  const tooBig = frame !== null && tooLargeToBuild(frame);

  const isCircleOrHex = shape === "circle" || shape === "hexagon";
  // For circle/hex, the user sees a single Diameter. Internally we update
  // both widthInches and heightInches in lockstep.
  const setDiameter = (d: number) => {
    if (shape === "circle") {
      onChange({ ...size, widthInches: d, heightInches: d });
    } else if (shape === "hexagon") {
      onChange({
        ...size,
        widthInches: d,
        heightInches: d * HEX_FLAT_TO_LONG,
      });
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <fieldset className="space-y-3">
        <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
          Print size
        </legend>

        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="What sets the print's size">
          {(["size", "scale"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onSizingModeChange(mode)}
              aria-pressed={sizing.mode === mode}
              disabled={frame === null}
              className={
                "rounded-md border py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 " +
                (sizing.mode === mode
                  ? "border-amber-400 bg-amber-400/10 text-amber-200"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
              }
            >
              {mode === "size" ? "Set size" : "Set scale"}
            </button>
          ))}
        </div>

        {scaleSet ? (
          <ScaleSetting
            denominator={sizing.denominator}
            onChange={onScaleChange}
            frame={frame}
            resortMode={resortMode}
            tooBig={tooBig}
          />
        ) : resortMode ? (
          <>
            <LabeledNumber
              label="Size (in)"
              value={size.widthInches}
              min={2}
              max={MAX_PRINT_INCHES}
              step={0.5}
              onChange={(v) => onChange({ ...size, widthInches: v, heightInches: v })}
            />
            <p className="text-xs text-slate-500">
              The mountain&apos;s longest side. The name tab adds to it.
            </p>
          </>
        ) : isCircleOrHex ? (
          <LabeledNumber
            label="Diameter (in)"
            value={size.widthInches}
            min={2}
            max={MAX_PRINT_INCHES}
            step={0.5}
            onChange={setDiameter}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <LabeledNumber
                label="Width (in)"
                value={size.widthInches}
                min={2}
                max={MAX_PRINT_INCHES}
                step={0.5}
                onChange={(v) => {
                  if (size.aspectLocked) {
                    onChange({ ...size, widthInches: v, heightInches: v });
                  } else {
                    onChange({ ...size, widthInches: v });
                  }
                }}
              />
              <LabeledNumber
                label="Height (in)"
                value={size.aspectLocked ? size.widthInches : size.heightInches}
                min={2}
                max={MAX_PRINT_INCHES}
                step={0.5}
                disabled={size.aspectLocked}
                onChange={(v) => onChange({ ...size, heightInches: v })}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={size.aspectLocked}
                onChange={(e) => {
                  const locked = e.target.checked;
                  if (locked) {
                    onChange({
                      ...size,
                      aspectLocked: true,
                      heightInches: size.widthInches,
                    });
                  } else {
                    onChange({ ...size, aspectLocked: false });
                  }
                }}
                className="accent-amber-400"
              />
              <span>Lock width = height</span>
            </label>
          </>
        )}

        {tooBig && (
          <p className="text-xs text-red-300" role="alert">
            {scaleSet ? (
              <>
                Too large to build: over {MAX_PRINT_INCHES} in. Use a scale between 1 :{" "}
                {formatDenominator(MIN_SCALE_DENOMINATOR)} and 1 : {formatDenominator(MAX_SCALE_DENOMINATOR)} with a
                bigger second number, or cover less ground.
              </>
            ) : (
              <>Too large to build: over {MAX_PRINT_INCHES} in{resortMode ? " with the frame around the mountain" : ""}. Set a smaller size.</>
            )}
          </p>
        )}

        <LabeledNumber
          label="Base thickness (in)"
          value={size.baseThicknessInches}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => onChange({ ...size, baseThicknessInches: v })}
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
          Model height
        </legend>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_RELIEF_INCHES}
            max={MAX_RELIEF_INCHES}
            step={0.05}
            value={size.reliefInches}
            onChange={(e) =>
              onChange({
                ...size,
                reliefInches: parseFloat(e.target.value),
              })
            }
            className="flex-1 accent-amber-400"
          />
          <span className="font-mono text-xs w-10 text-right">
            {size.reliefInches.toFixed(2)}&Prime;
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Base to peak on the print, set the same for every resort.
          {exaggeration !== null && (
            <>
              {" "}
              This one works out to{" "}
              <span className="font-mono">{exaggeration.toFixed(1)}&times;</span> true scale.
            </>
          )}
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
          Real-world coverage
        </legend>
        {resortMode ? (
          <div className="text-xs text-slate-400">
            Width: <span className="font-mono">{shapeWidthKm.toFixed(2)} km</span>, set by the resort.
          </div>
        ) : (
          <LabeledNumber
            label={isCircleOrHex ? "Diameter (km)" : "Width (km)"}
            value={Math.round(shapeWidthKm * 100) / 100}
            min={0.5}
            max={50}
            step={0.5}
            onChange={(v) => onShapeWidthMetersChange(v * 1000)}
          />
        )}
        <div className="text-xs text-slate-400">
          {isCircleOrHex || resortMode ? null : (
            <>
              Height: <span className="font-mono">{shapeHeightKm.toFixed(2)} km</span>
              {bbox && !scaleSet && <>{" "}&middot;{" "}</>}
            </>
          )}
          {bbox && !scaleSet && (
            <>
              scale &asymp;{" "}
              <span className="font-mono">1 : {formatDenominator(scaleDenominator)}</span>
            </>
          )}
        </div>
      </fieldset>
    </div>
  );
}

function inchesAndMm(inches: number): string {
  return `${inches.toFixed(1)} in (${Math.round(inches * MM_PER_INCH)} mm)`;
}

/** Always with commas: the scale field reads back what this writes. */
function formatDenominator(denominator: number): string {
  return denominator.toLocaleString("en-US");
}

/** The scale field with its presets, and the size the print comes out at. */
function ScaleSetting({
  denominator,
  onChange,
  frame,
  resortMode,
  tooBig,
}: {
  denominator: number;
  onChange: (denominator: number) => void;
  frame: PrintFrame | null;
  resortMode: boolean;
  tooBig: boolean;
}) {
  // Uncontrolled, committed on blur or Enter: a scale typed digit by digit
  // passes through values that would each resize the print. The field is
  // rewritten with what was understood, so it never shows a rejected entry.
  const commit = (field: HTMLInputElement) => {
    const understood = parseScaleDenominator(field.value) ?? denominator;
    field.value = formatDenominator(understood);
    if (understood !== denominator) onChange(understood);
  };
  const longest = frame ? Math.max(frame.stated.widthInches, frame.stated.heightInches) : 0;
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-xs text-slate-400 mb-1">Scale</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-300">1 :</span>
          <input
            key={denominator}
            type="text"
            inputMode="numeric"
            defaultValue={formatDenominator(denominator)}
            aria-label="Scale: one to"
            onBlur={(e) => commit(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="w-full rounded-md border px-2 py-1.5 text-sm font-mono bg-slate-900/80 border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </span>
      </label>
      <div className="flex flex-wrap gap-1">
        {SCALE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            aria-pressed={preset === denominator}
            className={
              "rounded border px-1.5 py-0.5 text-[11px] font-mono transition " +
              (preset === denominator
                ? "border-amber-400 text-amber-200"
                : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
            }
          >
            {preset / 1000}k
          </button>
        ))}
      </div>
      {frame && (
        <p className="text-xs text-slate-400">
          {resortMode ? (
            <>
              The mountain prints <span className="font-mono">{inchesAndMm(longest)}</span> on its longest
              side. The name tab adds to it.
            </>
          ) : (
            <>
              Prints{" "}
              <span className="font-mono">
                {frame.stated.widthInches.toFixed(1)} &times; {frame.stated.heightInches.toFixed(1)} in (
                {Math.round(frame.stated.widthInches * MM_PER_INCH)} &times;{" "}
                {Math.round(frame.stated.heightInches * MM_PER_INCH)} mm)
              </span>
              .
            </>
          )}
          {longest * MM_PER_INCH > BED_MM && !tooBig && <> Larger than a {BED_MM} mm bed.</>}
        </p>
      )}
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      <input
        type="number"
        className={
          "w-full rounded-md border px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400 " +
          (disabled
            ? "bg-slate-900/40 border-slate-800 text-slate-500 cursor-not-allowed"
            : "bg-slate-900/80 border-slate-700")
        }
        value={Number.isFinite(value) ? +value.toFixed(2) : value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </label>
  );
}
