"use client";

// Shape selector: picks the geometric footprint of the 3D model. Selecting
// a non-rectangle shape locks the bbox aspect so the inscribed figure
// fills the frame.

import type { Shape } from "@/lib/shape";

interface Props {
  shape: Shape;
  onChange: (next: Shape) => void;
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

export default function ShapeControls({ shape, onChange }: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Shape
      </legend>
      <div className="grid grid-cols-3 gap-1.5">
        {OPTIONS.map((opt) => {
          const active = opt.value === shape;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={
                "flex flex-col items-center justify-center gap-1 rounded-md py-2 px-1 text-[10px] uppercase tracking-wide border transition " +
                (active
                  ? "border-amber-400 bg-amber-400/10 text-amber-200"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
              }
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
