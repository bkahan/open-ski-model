"use client";

// Mesh density (= elevation-grid resolution). Higher density gives
// smoother shape edges and more terrain detail, at the cost of larger
// STL files and slower elevation fetches (file size scales ~N²).

interface Props {
  gridSize: number;
  onChange: (next: number) => void;
}

const PRESETS = [
  { label: "Normal", value: 256 },
  { label: "High", value: 512 },
] as const;

const CUSTOM_MIN = 128;
const CUSTOM_MAX = 1024;
const CUSTOM_DEFAULT = 384;

export default function DensityControls({ gridSize, onChange }: Props) {
  const matchedPreset = PRESETS.find((p) => p.value === gridSize);
  const isCustom = !matchedPreset;
  const warn = gridSize > 512;

  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Density
      </legend>
      <div className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => {
          const active = !isCustom && p.value === gridSize;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.value)}
              aria-pressed={active}
              className={
                "rounded-md py-2 px-1 text-[11px] uppercase tracking-wide border transition " +
                (active
                  ? "border-amber-400 bg-amber-400/10 text-amber-200"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
              }
            >
              {p.label}
              <div className="font-mono text-[9px] text-slate-500">{p.value}</div>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onChange(isCustom ? gridSize : CUSTOM_DEFAULT)}
          aria-pressed={isCustom}
          className={
            "rounded-md py-2 px-1 text-[11px] uppercase tracking-wide border transition " +
            (isCustom
              ? "border-amber-400 bg-amber-400/10 text-amber-200"
              : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
          }
        >
          Custom
          <div className="font-mono text-[9px] text-slate-500">
            {isCustom ? gridSize : "—"}
          </div>
        </button>
      </div>
      {isCustom && (
        <div className="flex items-center gap-3 pt-1">
          <input
            type="range"
            min={CUSTOM_MIN}
            max={CUSTOM_MAX}
            step={16}
            value={gridSize}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="flex-1 accent-amber-400"
          />
          <span className="font-mono text-xs w-12 text-right">{gridSize}</span>
        </div>
      )}
      {warn && (
        <p className="text-[11px] text-amber-300/80 leading-snug">
          High density takes longer to fetch and produces a larger STL.
        </p>
      )}
    </fieldset>
  );
}
