"use client";

import { PLACE_MAX_CHARS } from "@/lib/resort/place";

// Engraving toggles:
//   - "Label + compass": adds a beveled plinth around the model and
//     engraves the place name plus a compass rose on
//     the rim facing the resort's base (the bottom of the frame when
//     there is no resort). The rim is tilted 35° from horizontal so
//     the engraving faces up when the model sits on a desk. A second
//     line under the name takes the town and state, in small capitals.
//   - "Brand on bottom": engraves "craftedcarving.com" on the bottom
//     face. Independent of the label toggle.

interface Props {
  label: boolean;
  brand: boolean;
  onChange: (next: { label: boolean; brand: boolean }) => void;
  /** Second line of the name plate; empty for a one-line plate. */
  place: string;
  onPlaceChange: (place: string) => void;
  /** The field took focus: a town still being looked up must not replace what gets typed. */
  onPlaceEditStart: () => void;
}

export default function EngravingControls({
  label,
  brand,
  onChange,
  place,
  onPlaceChange,
  onPlaceEditStart,
}: Props) {
  // Typing doesn't rebuild the model letter by letter: the line is taken
  // when the field is left or Enter is pressed.
  const commitPlace = (value: string) => {
    const next = value.trim();
    if (next !== place) onPlaceChange(next);
  };

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
            Adds a beveled plinth with the place name and a compass rose on the rim facing the base area.
          </span>
        </span>
      </label>
      {label && (
        <label className="block pl-5 text-xs text-slate-300">
          <span className="text-slate-200">Second line</span>
          {/* Keyed on the value so a looked-up town replaces what the field shows. */}
          <input
            key={place}
            type="text"
            defaultValue={place}
            placeholder="Jay, VT"
            maxLength={PLACE_MAX_CHARS}
            onFocus={onPlaceEditStart}
            onBlur={(e) => commitPlace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
          <span className="mt-1 block text-[10px] text-slate-500">
            Town and state under the name, set in capitals. Filled in when you pick a resort; edit it or clear it for one line.
          </span>
        </label>
      )}
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
