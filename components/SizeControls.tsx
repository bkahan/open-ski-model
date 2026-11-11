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

import { bboxWidthMeters } from "@/lib/bbox";
import {
  HEX_FLAT_TO_LONG,
  shapeAABBHalf,
  type Shape,
} from "@/lib/shape";
import type { Bbox } from "@/lib/types";

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
  rotation: number;
  onChange: (next: SizeState) => void;
  bbox: Bbox | null;
  /** Exaggeration the current model height works out to, once terrain is loaded. */
  exaggeration: number | null;
  /** Sets the SHAPE's real-world width in meters (not the bbox AABB). */
  onShapeWidthMetersChange: (widthMeters: number) => void;
}

export default function SizeControls({
  size,
  shape,
  rotation,
  onChange,
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
  const scaleDenominator = bbox
    ? Math.round(metersPerInch / 0.0254)
    : 0;

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

        {isCircleOrHex ? (
          <LabeledNumber
            label="Diameter (in)"
            value={size.widthInches}
            min={2}
            max={24}
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
                max={24}
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
                max={24}
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
            min={0.25}
            max={4}
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
        <LabeledNumber
          label={isCircleOrHex ? "Diameter (km)" : "Width (km)"}
          value={Math.round(shapeWidthKm * 100) / 100}
          min={0.5}
          max={50}
          step={0.5}
          onChange={(v) => onShapeWidthMetersChange(v * 1000)}
        />
        <div className="text-xs text-slate-400">
          {isCircleOrHex ? null : (
            <>
              Height: <span className="font-mono">{shapeHeightKm.toFixed(2)} km</span>
              {" "}&middot;{" "}
            </>
          )}
          {bbox && (
            <>
              scale &asymp;{" "}
              <span className="font-mono">1 : {scaleDenominator.toLocaleString()}</span>
            </>
          )}
        </div>
      </fieldset>
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
