"use client";

// Shape selector: picks the footprint of the 3D model. Selecting a
// non-rectangle shape locks the bbox aspect so the inscribed figure fills
// the frame. "Resort" is the outline of the ski area picked in search,
// so it is only on offer once one has been picked.

import type { Shape } from "@/lib/shape";

interface Props {
  shape: Shape;
  silhouette: boolean;
  /** Whether a ski area has been picked for Resort to outline. */
  resortAvailable: boolean;
  onChange: (next: Shape) => void;
  onSilhouette: () => void;
}

const OPTIONS: Array<{ value: Shape; label: string; icon: JSX.Element }> = [
  {
    value: "rectangle",
    label: "Rectangle",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="6" width="18" height="12" rx="1" />
      </svg>
    ),
  },
  {
    value: "circle",
    label: "Circle",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    value: "hexagon",
    label: "Hex",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
        <polygon points="20,12 16,19 8,19 4,12 8,5 16,5" />
      </svg>
    ),
  },
];

const BUTTON_BASE =
  "flex flex-col items-center justify-center gap-1 rounded-md py-2 px-1 text-[10px] uppercase tracking-wide border transition ";
const BUTTON_ACTIVE = "border-amber-400 bg-amber-400/10 text-amber-200";
const BUTTON_IDLE = "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200";
const BUTTON_DISABLED = "border-slate-800 text-slate-600 cursor-not-allowed";

export default function ShapeControls({ shape, silhouette, resortAvailable, onChange, onSilhouette }: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Shape
      </legend>
      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          onClick={onSilhouette}
          aria-pressed={silhouette}
          disabled={!resortAvailable}
          title={resortAvailable ? undefined : "Pick a ski resort in search first"}
          className={BUTTON_BASE + (silhouette ? BUTTON_ACTIVE : resortAvailable ? BUTTON_IDLE : BUTTON_DISABLED)}
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 15c-1-5 3-6 5-9 2-2 5 0 6 2 2 3 6 3 5 8-1 4-5 2-8 3-3 0-7 1-8-4z" />
          </svg>
          <span>Resort</span>
        </button>
        {OPTIONS.map((opt) => {
          const active = !silhouette && opt.value === shape;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={BUTTON_BASE + (active ? BUTTON_ACTIVE : BUTTON_IDLE)}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
