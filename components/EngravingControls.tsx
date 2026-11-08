"use client";

// Engraving toggles:
//   - "Label + compass": adds a beveled plinth around the model and
//     engraves the place name plus a north-pointing compass arrow on
//     the rim facing the resort's base (the bottom of the frame when
//     there is no resort). The rim is tilted 35° from horizontal so
//     the engraving faces up when the model sits on a desk.
//   - "Brand on bottom": engraves "craftedcarving.com" on the bottom
//     face. Independent of the label toggle.

interface Props {
  label: boolean;
  brand: boolean;
  onChange: (next: { label: boolean; brand: boolean }) => void;
}

export default function EngravingControls({ label, brand, onChange }: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Engravings
      </legend>
      <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={label}
          onChange={(e) => onChange({ label: e.target.checked, brand })}
          className="accent-amber-400 mt-0.5"
        />
        <span className="leading-snug">
          <span className="text-slate-200">Label + compass</span>
          <span className="block text-[10px] text-slate-500">
            Adds a beveled plinth with the place name and a north arrow on the rim facing the base area.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={brand}
          onChange={(e) => onChange({ label, brand: e.target.checked })}
          className="accent-amber-400 mt-0.5"
        />
        <span className="leading-snug">
          <span className="text-slate-200">Brand on bottom</span>
          <span className="block text-[10px] text-slate-500">
            Engraves <span className="font-mono">craftedcarving.com</span> centered on the underside.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
