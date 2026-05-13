"use client";

// Controls panel:
//   - Physical print width/height in inches
//   - Base thickness in inches
//   - Vertical exaggeration multiplier
//   - Real-world bbox size (km) — derived from the map bbox, but editable
//     here as a direct numeric override.
//
// The physical aspect ratio (width / height) is the "lock" that the map
// bbox follows. If the user types width 6, height 6, the bbox stays square.

import type { Bbox } from "@/lib/types";
import { bboxHeightMeters, bboxWidthMeters } from "@/lib/bbox";

export interface SizeState {
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  verticalExaggeration: number;
}

interface Props {
  size: SizeState;
  onChange: (next: SizeState) => void;
  bbox: Bbox | null;
  onCoverageChange: (widthMeters: number) => void;
}

export default function SizeControls({
  size,
  onChange,
  bbox,
  onCoverageChange,
}: Props) {
  const widthKm = bbox ? bboxWidthMeters(bbox) / 1000 : 0;
  const heightKm = bbox ? bboxHeightMeters(bbox) / 1000 : 0;
  const scaleDenominator = bbox
    ? Math.round(bboxWidthMeters(bbox) / (size.widthInches * 0.0254))
    : 0;

  return (
    <div className="space-y-4 text-sm">
      <fieldset className="space-y-3">
        <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
          Print size
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <LabeledNumber
            label="Width (in)"
            value={size.widthInches}
            min={2}
            max={24}
            step={0.5}
            onChange={(v) => onChange({ ...size, widthInches: v })}
          />
          <LabeledNumber
            label="Height (in)"
            value={size.heightInches}
            min={2}
            max={24}
            step={0.5}
            onChange={(v) => onChange({ ...size, heightInches: v })}
          />
        </div>
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
          Vertical exaggeration
        </legend>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={5}
            step={0.1}
            value={size.verticalExaggeration}
            onChange={(e) =>
              onChange({
                ...size,
                verticalExaggeration: parseFloat(e.target.value),
              })
            }
            className="flex-1 accent-amber-400"
          />
          <span className="font-mono text-xs w-10 text-right">
            {size.verticalExaggeration.toFixed(1)}&times;
          </span>
        </div>
        <p className="text-xs text-slate-500">
          True scale (1&times;) usually looks flat on a small print. 2&ndash;3&times;
          tends to read best.
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
          Real-world coverage
        </legend>
        <LabeledNumber
          label="Box width (km)"
          value={Math.round(widthKm * 100) / 100}
          min={0.5}
          max={50}
          step={0.5}
          onChange={(v) => onCoverageChange(v * 1000)}
        />
        <div className="text-xs text-slate-400">
          Box height: <span className="font-mono">{heightKm.toFixed(2)} km</span>
          {bbox && (
            <>
              {" "}&middot; scale &asymp;{" "}
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      <input
        type="number"
        className="w-full rounded-md bg-slate-900/80 border border-slate-700 px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </label>
  );
}
