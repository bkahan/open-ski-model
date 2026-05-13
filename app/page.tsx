"use client";

// Home page state machine:
//
//        "map"  ──Generate──▶  "loading"  ──ok──▶  "viewer"
//          ▲                       │
//          └────── Back ───────────┴── error ──▶ back to "map"
//
// State is mirrored to URL search params so a deep link reopens the same
// bbox + print spec.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

import SearchBar from "@/components/SearchBar";
import SizeControls, { type SizeState } from "@/components/SizeControls";
import {
  bboxCenter,
  bboxFromCenter,
  bboxWidthMeters,
  snapBboxToAspect,
} from "@/lib/bbox";
import type {
  ElevationRequest,
  ElevationResponse,
} from "@/lib/elevation/types";
import type { Bbox, LngLat, SearchResult } from "@/lib/types";
import { decodeUrlState, syncUrl } from "@/lib/url-state";

const MapPicker = dynamic(() => import("@/components/MapPicker"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-slate-500 text-sm">
      Loading map&hellip;
    </div>
  ),
});

const ModelViewer = dynamic(() => import("@/components/ModelViewer"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-slate-500 text-sm">
      Loading 3D engine&hellip;
    </div>
  ),
});

const DEFAULT_CENTER: LngLat = [-72.5, 44.93];
const DEFAULT_GRID_SIZE = 256;

type View = "map" | "loading" | "viewer";

/**
 * Snapshot captured when entering "viewer". The 3D scene is bound to
 * these values — if the user keeps tweaking the sidebar controls after
 * generating, the visualization stays consistent with the elevation
 * grid that was actually fetched. Only base thickness and vertical
 * exaggeration are live-tunable; everything else needs a Regenerate.
 */
interface ViewerSnapshot {
  bbox: Bbox;
  widthInches: number;
  heightInches: number;
  data: ElevationResponse;
  label?: string;
}

export default function Home() {
  const [size, setSize] = useState<SizeState>({
    widthInches: 6,
    heightInches: 6,
    baseThicknessInches: 0.25,
    verticalExaggeration: 2,
  });
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [flyTo, setFlyTo] = useState<LngLat | null>(null);
  const [label, setLabel] = useState<string | undefined>("Jay Peak");
  const [view, setView] = useState<View>("map");
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didHydrateFromUrl = useRef(false);

  const aspect = useMemo(
    () => size.widthInches / size.heightInches,
    [size.widthInches, size.heightInches],
  );

  // --- Hydrate from URL on mount ---
  useEffect(() => {
    if (didHydrateFromUrl.current) return;
    didHydrateFromUrl.current = true;

    const url = new URL(window.location.href);
    const parsed = decodeUrlState(url.searchParams);

    setSize((s) => ({
      widthInches: parsed.widthInches ?? s.widthInches,
      heightInches: parsed.heightInches ?? s.heightInches,
      baseThicknessInches: parsed.baseThicknessInches ?? s.baseThicknessInches,
      verticalExaggeration: parsed.verticalExaggeration ?? s.verticalExaggeration,
    }));
    if (parsed.label) setLabel(parsed.label);
    if (parsed.bbox) {
      setBbox(parsed.bbox);
      setFlyTo(bboxCenter(parsed.bbox));
    } else {
      setBbox(bboxFromCenter(DEFAULT_CENTER, 5_000, 1));
    }
  }, []);

  // --- Refit bbox when aspect changes (after hydration) ---
  useEffect(() => {
    if (!didHydrateFromUrl.current) return;
    setBbox((b) => {
      if (!b) return b;
      const center = bboxCenter(b);
      const w = bboxWidthMeters(b);
      return bboxFromCenter(center, w, aspect);
    });
  }, [aspect]);

  // --- Mirror state to URL whenever it stabilizes ---
  useEffect(() => {
    if (!bbox) return;
    const timer = setTimeout(() => {
      syncUrl({
        bbox,
        widthInches: size.widthInches,
        heightInches: size.heightInches,
        baseThicknessInches: size.baseThicknessInches,
        verticalExaggeration: size.verticalExaggeration,
        label,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [bbox, size, label]);

  const handleSearch = (result: SearchResult) => {
    setLabel(result.displayName.split(",")[0]);
    setFlyTo(result.center);
    setBbox(snapBboxToAspect(result.bbox, aspect, 5_000));
  };

  const handleCoverageChange = (widthMeters: number) => {
    if (!bbox) return;
    const center = bboxCenter(bbox);
    setBbox(bboxFromCenter(center, widthMeters, aspect));
  };

  const handleGenerate = async () => {
    if (!bbox) return;
    setError(null);
    setView("loading");
    try {
      const payload: ElevationRequest = {
        bbox,
        gridSize: DEFAULT_GRID_SIZE,
        source: "auto",
      };
      const res = await fetch("/api/elevation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ElevationResponse;
      setSnapshot({
        bbox,
        widthInches: size.widthInches,
        heightInches: size.heightInches,
        data,
        label,
      });
      setView("viewer");
    } catch (err) {
      console.error("[generate]", err);
      setError(err instanceof Error ? err.message : "elevation request failed");
      setView("map");
    }
  };

  const handleBack = () => setView("map");

  return (
    <main className="flex flex-col md:flex-row h-screen">
      <aside className="w-full md:w-80 md:min-w-80 border-b md:border-b-0 md:border-r border-slate-800 bg-slate-950/80 backdrop-blur p-4 space-y-5 overflow-y-auto">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">
            Open Ski Model
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Pick a mountain, frame it, generate a 3D print.
          </p>
          {label && view !== "map" && (
            <p className="text-xs text-amber-300 font-mono mt-1">{label}</p>
          )}
        </header>

        <SearchBar onSelect={handleSearch} />

        <SizeControls
          size={size}
          onChange={setSize}
          bbox={bbox}
          onCoverageChange={handleCoverageChange}
        />

        {view === "viewer" && snapshot && (
          <div className="text-xs text-slate-400 bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-1 font-mono">
            <div>elev min: <span className="text-slate-100">{Math.round(snapshot.data.min)} m</span></div>
            <div>elev max: <span className="text-slate-100">{Math.round(snapshot.data.max)} m</span></div>
            <div>relief: <span className="text-slate-100">{Math.round(snapshot.data.max - snapshot.data.min)} m</span></div>
            <div>source: <span className="text-slate-100">{snapshot.data.source}{snapshot.data.source === "terrarium" ? `@z${snapshot.data.zoom}` : ""}</span></div>
          </div>
        )}

        {view === "map" && (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!bbox}
            className="w-full rounded-md bg-amber-400 text-slate-950 font-semibold py-2.5 text-sm hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            Generate 3D model
          </button>
        )}

        {view === "loading" && (
          <button
            type="button"
            disabled
            className="w-full rounded-md bg-amber-400/60 text-slate-950 font-semibold py-2.5 text-sm cursor-wait"
          >
            Fetching elevation&hellip;
          </button>
        )}

        {view === "viewer" && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleBack}
              className="w-full rounded-md border border-slate-700 text-slate-200 py-2.5 text-sm hover:bg-slate-900 transition"
            >
              ← Back to map
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              className="w-full rounded-md bg-amber-400 text-slate-950 font-semibold py-2 text-sm hover:bg-amber-300 transition"
            >
              Regenerate
            </button>
          </div>
        )}

        {error && (
          <div className="text-xs rounded-md bg-red-950/60 border border-red-900 text-red-300 p-2">
            {error}
          </div>
        )}

        <footer className="text-[11px] text-slate-500 leading-relaxed pt-2 border-t border-slate-800">
          <p>
            Phase 3 ✓ Watertight mesh, contour lines, sun-angle hillshade,
            STL export, shareable URLs, installable PWA, auto USGS 3DEP for
            US bboxes.
          </p>
        </footer>
      </aside>

      <section className="flex-1 relative min-h-[60vh]">
        {view !== "viewer" && (
          <MapPicker
            bbox={bbox}
            aspect={aspect}
            onBboxChange={setBbox}
            flyTo={flyTo}
          />
        )}
        {view === "viewer" && snapshot && (
          <ModelViewer
            bbox={snapshot.bbox}
            data={snapshot.data}
            widthInches={snapshot.widthInches}
            heightInches={snapshot.heightInches}
            baseThicknessInches={size.baseThicknessInches}
            verticalExaggeration={size.verticalExaggeration}
            label={snapshot.label}
          />
        )}
        {view === "loading" && (
          <div className="absolute inset-0 bg-slate-950/70 flex items-center justify-center">
            <div className="text-sm text-slate-300 animate-pulse">
              Building height grid&hellip;
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
