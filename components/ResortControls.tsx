"use client";

// Ski-resort overlay: downhill runs colored by difficulty, lifts as gray
// stripes. Runs narrower than the minimum width are widened so they
// survive printing.

import { useState } from "react";

import {
  COLOR_SCHEME_SETTINGS,
  isColorSchemeSetting,
  type ColorScheme,
  type ColorSchemeSetting,
} from "@/lib/resort/colors";
import {
  clampRunWidth,
  MAX_RUN_WIDTH_MM,
  MIN_RUN_WIDTH_MM,
  type ResortSettings,
} from "@/lib/resort/settings";
import type { ResortData } from "@/lib/resort/types";

interface Props {
  settings: ResortSettings;
  onChange: (next: ResortSettings) => void;
  resort: ResortData | null;
  loading: boolean;
  error: string | null;
  /** The scheme in effect once "auto" is resolved against the bbox. */
  resolvedScheme: ColorScheme;
}

const SCHEME_LABELS: Record<ColorSchemeSetting, string> = {
  auto: "Auto",
  na: "N. America",
  eu: "Europe",
};

export default function ResortControls({
  settings,
  onChange,
  resort,
  loading,
  error,
  resolvedScheme,
}: Props) {
  const set = <K extends keyof ResortSettings>(key: K, value: ResortSettings[K]) =>
    onChange({ ...settings, [key]: value });

  // The width field keeps a draft so "0.8" can be typed without "0"
  // being clamped mid-keystroke; it commits on blur or Enter.
  const [widthDraft, setWidthDraft] = useState(String(settings.minRunWidthMm));
  const [committedWidth, setCommittedWidth] = useState(settings.minRunWidthMm);
  if (committedWidth !== settings.minRunWidthMm) {
    setCommittedWidth(settings.minRunWidthMm);
    setWidthDraft(String(settings.minRunWidthMm));
  }
  const commitWidth = () => {
    const v = parseFloat(widthDraft);
    if (Number.isFinite(v)) set("minRunWidthMm", clampRunWidth(v));
    else setWidthDraft(String(settings.minRunWidthMm));
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-slate-400 uppercase tracking-wider text-xs mb-1">
        Ski runs
      </legend>

      <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={settings.showRuns}
          onChange={(e) => set("showRuns", e.target.checked)}
          className="accent-amber-400 mt-0.5"
        />
        <span className="leading-snug">
          <span className="text-slate-200">Show runs</span>
          <span className="block text-[10px] text-slate-500">
            Downhill pistes from OpenStreetMap, colored by difficulty.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={settings.showLifts}
          disabled={!settings.showRuns}
          onChange={(e) => set("showLifts", e.target.checked)}
          className="accent-amber-400 mt-0.5 disabled:opacity-40"
        />
        <span className={"leading-snug " + (settings.showRuns ? "" : "opacity-40")}>
          <span className="text-slate-200">Lifts</span>
          <span className="block text-[10px] text-slate-500">
            Chairs, gondolas and surface lifts as thin gray stripes.
          </span>
        </span>
      </label>

      <div className={"flex items-center justify-between gap-3 pt-1 " + (settings.showRuns ? "" : "opacity-40")}>
        <label htmlFor="min-run-width" className="text-xs text-slate-300">
          Min run width
        </label>
        <div className="flex items-center gap-1">
          <input
            id="min-run-width"
            type="number"
            min={MIN_RUN_WIDTH_MM}
            max={MAX_RUN_WIDTH_MM}
            step={0.1}
            disabled={!settings.showRuns}
            value={widthDraft}
            onChange={(e) => setWidthDraft(e.target.value)}
            onBlur={commitWidth}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="w-16 rounded-md bg-slate-900/80 border border-slate-700 px-2 py-1 text-xs font-mono text-right focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
          />
          <span className="text-xs text-slate-500">mm</span>
        </div>
      </div>

      <div className={"flex items-center justify-between gap-3 " + (settings.showRuns ? "" : "opacity-40")}>
        <label htmlFor="color-scheme" className="text-xs text-slate-300">
          Trail colors
        </label>
        <select
          id="color-scheme"
          disabled={!settings.showRuns}
          value={settings.colorScheme}
          onChange={(e) => {
            if (isColorSchemeSetting(e.target.value)) set("colorScheme", e.target.value);
          }}
          className="rounded-md bg-slate-900/80 border border-slate-700 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
        >
          {COLOR_SCHEME_SETTINGS.map((s) => (
            <option key={s} value={s}>
              {SCHEME_LABELS[s]}
              {s === "auto" ? ` (${SCHEME_LABELS[resolvedScheme]})` : ""}
            </option>
          ))}
        </select>
      </div>

      {settings.showRuns && (
        <p className="text-[11px] text-slate-500 font-mono">
          {loading
            ? "loading runs…"
            : error
              ? <span className="text-red-300 font-sans">{error}</span>
              : resort
                ? `${resort.runs.length} runs · ${resort.lifts.length} lifts`
                : "—"}
        </p>
      )}
    </fieldset>
  );
}
