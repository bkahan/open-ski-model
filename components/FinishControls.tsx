"use client";

// Surface finish: the terrain's real slope, or flat stacked elevation steps
// like a laser-cut contour model.

import {
  DEFAULT_LAYER_COUNT,
  MAX_LAYER_COUNT,
  MIN_LAYER_COUNT,
} from "@/lib/mesh/layers";

interface Props {
  /** Number of steps; 0 is the smooth finish. */
  layerCount: number;
  onChange: (next: number) => void;
}

const BUTTON_BASE = "rounded-md py-2 px-1 text-[10px] uppercase tracking-wide border transition ";
const BUTTON_ACTIVE = "border-amber-400 bg-amber-400/10 text-amber-200";
const BUTTON_IDLE = "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200";

export default function FinishControls({ layerCount, onChange }: Props) {
  const stacked = layerCount > 0;
  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Finish
      </legend>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          aria-pressed={!stacked}
          onClick={() => onChange(0)}
          className={BUTTON_BASE + (stacked ? BUTTON_IDLE : BUTTON_ACTIVE)}
        >
          Smooth
        </button>
        <button
          type="button"
          aria-pressed={stacked}
          onClick={() => onChange(stacked ? layerCount : DEFAULT_LAYER_COUNT)}
          className={BUTTON_BASE + (stacked ? BUTTON_ACTIVE : BUTTON_IDLE)}
        >
          Stacked
        </button>
      </div>
      {stacked && (
        <div className="flex items-center gap-3">
          <label htmlFor="layer-count" className="text-xs text-slate-300">
            Layers
          </label>
          <input
            id="layer-count"
            type="range"
            min={MIN_LAYER_COUNT}
            max={MAX_LAYER_COUNT}
            step={1}
            value={layerCount}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="flex-1 accent-amber-400"
          />
          <span className="font-mono text-xs w-6 text-right">{layerCount}</span>
        </div>
      )}
    </fieldset>
  );
}
