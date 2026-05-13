"use client";

// Home page state machine:
//
//        "map"  ──Generate──▶  "loading"  ──ok──▶  "viewer"
//          ▲                       │
//          └────── Back ───────────┴── error ──▶ back to "map"
//
// State model:
//   - `shape` (rectangle | circle | hexagon), `rotation` (degrees), and
//     `size.widthInches` / `size.heightInches` (shape's pre-rotation
//     dimensions in inches) describe the model footprint.
//   - `bbox` is the axis-aligned geographic bbox containing the rotated
//     shape — the area the elevation API samples. It's kept in sync with
//     the shape parameters; the user manipulates the SHAPE on the map,
//     and the bbox AABB follows.
//   - URL search params mirror this state so a deep link reopens the
//     same view.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

import DensityControls from "@/components/DensityControls";
import EngravingControls from "@/components/EngravingControls";
import SearchBar from "@/components/SearchBar";
import ShapeControls from "@/components/ShapeControls";
import SizeControls, { type SizeState } from "@/components/SizeControls";
import {
  bboxCenter,
  bboxFromCenterWH,
  bboxWidthMeters,
  snapBboxToAspect,
} from "@/lib/bbox";
import type {
  ElevationRequest,
  ElevationResponse,
} from "@/lib/elevation/types";
import {
  HEX_FLAT_TO_LONG,
  shapeAABBHalf,
  type Shape,
} from "@/lib/shape";
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
const DEFAULT_SHAPE_WIDTH_METERS = 5_000;
const DEFAULT_GRID_SIZE = 256;
const MIN_GRID_SIZE = 64;
const MAX_GRID_SIZE = 2048;

type View = "map" | "loading" | "viewer";

interface ViewerSnapshot {
  bbox: Bbox;
  shape: Shape;
  rotation: number;
  widthInches: number;
  heightInches: number;
  data: ElevationResponse;
  label?: string;
}

/** Helper: build the geographic AABB for the current shape at the given scale. */
function bboxForShape(
  center: LngLat,
  shape: Shape,
  widthInches: number,
  heightInches: number,
  rotation: number,
  metersPerInch: number,
): Bbox {
  const [halfWIn, halfHIn] = shapeAABBHalf(
    shape,
    widthInches,
    heightInches,
    rotation,
  );
  return bboxFromCenterWH(
    center,
    halfWIn * 2 * metersPerInch,
    halfHIn * 2 * metersPerInch,
  );
}

/** Helper: extract current scale (m/in) from a bbox + shape state. */
function scaleMPerIn(
  bbox: Bbox,
  shape: Shape,
  widthInches: number,
  heightInches: number,
  rotation: number,
): number {
  const halfWIn = shapeAABBHalf(shape, widthInches, heightInches, rotation)[0];
  return bboxWidthMeters(bbox) / (halfWIn * 2);
}

export default function Home() {
  const [size, setSize] = useState<SizeState>({
    widthInches: 6,
    heightInches: 6,
    baseThicknessInches: 0.25,
    verticalExaggeration: 2,
    aspectLocked: true,
  });
  const [shape, setShape] = useState<Shape>("rectangle");
  const [rotation, setRotation] = useState(0);
  const [gridSize, setGridSize] = useState<number>(DEFAULT_GRID_SIZE);
  const [engraveLabel, setEngraveLabel] = useState<boolean>(false);
  const [engraveBrand, setEngraveBrand] = useState<boolean>(true);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [flyTo, setFlyTo] = useState<LngLat | null>(null);
  const [label, setLabel] = useState<string | undefined>("Jay Peak");
  const [view, setView] = useState<View>("map");
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didHydrateFromUrl = useRef(false);

  // --- Hydrate from URL on mount ---
  useEffect(() => {
    if (didHydrateFromUrl.current) return;
    didHydrateFromUrl.current = true;

    const url = new URL(window.location.href);
    const parsed = decodeUrlState(url.searchParams);

    const sh: Shape = parsed.shape ?? "rectangle";
    const rot = sh === "circle" ? 0 : parsed.rotation ?? 0;
    let w = parsed.widthInches ?? 6;
    let h = parsed.heightInches ?? 6;
    const locked = parsed.aspectLocked ?? true;
    // Enforce shape-specific aspect on hydrate.
    if (sh === "circle") h = w;
    else if (sh === "hexagon") h = w * HEX_FLAT_TO_LONG;
    else if (locked) h = w;

    setShape(sh);
    setRotation(rot);
    setSize({
      widthInches: w,
      heightInches: h,
      baseThicknessInches: parsed.baseThicknessInches ?? 0.25,
      verticalExaggeration: parsed.verticalExaggeration ?? 2,
      aspectLocked: locked,
    });
    if (parsed.gridSize !== undefined) {
      setGridSize(
        Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, parsed.gridSize)),
      );
    }
    if (parsed.engraveLabel !== undefined) setEngraveLabel(parsed.engraveLabel);
    if (parsed.engraveBrand !== undefined) setEngraveBrand(parsed.engraveBrand);
    if (parsed.label) setLabel(parsed.label);
    if (parsed.bbox) {
      setBbox(parsed.bbox);
      setFlyTo(bboxCenter(parsed.bbox));
    } else {
      // Default: 5 km shape at the default center.
      const metersPerInch = DEFAULT_SHAPE_WIDTH_METERS / w;
      setBbox(bboxForShape(DEFAULT_CENTER, sh, w, h, rot, metersPerInch));
    }
  }, []);

  // --- Mirror state to URL whenever it stabilizes ---
  useEffect(() => {
    if (!bbox) return;
    const timer = setTimeout(() => {
      syncUrl({
        bbox,
        shape,
        rotation,
        widthInches: size.widthInches,
        heightInches: size.heightInches,
        baseThicknessInches: size.baseThicknessInches,
        verticalExaggeration: size.verticalExaggeration,
        aspectLocked: size.aspectLocked,
        gridSize,
        engraveLabel,
        engraveBrand,
        label,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [bbox, shape, rotation, size, gridSize, engraveLabel, engraveBrand, label]);

  // All bbox refits are done inside the explicit handlers (handleShapeChange,
  // handleSizeChange, etc.) since they already know the old state. We
  // intentionally do NOT auto-refit in an effect — that would race with
  // the handlers and compute scale from stale references.

  // Memo "starting AABB aspect" so search snapping can use it.
  const aabbAspect = useMemo(() => {
    const [hW, hH] = shapeAABBHalf(
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    return hW / hH;
  }, [shape, size.widthInches, size.heightInches, rotation]);

  const handleSearch = (result: SearchResult) => {
    setLabel(result.displayName.split(",")[0]);
    setFlyTo(result.center);
    setBbox(snapBboxToAspect(result.bbox, aabbAspect, DEFAULT_SHAPE_WIDTH_METERS));
  };

  /** "Box width (km)" — sets the SHAPE's real-world width. */
  const handleShapeWidthMetersChange = (widthMeters: number) => {
    if (!bbox) return;
    const newScale = widthMeters / size.widthInches;
    const center = bboxCenter(bbox);
    setBbox(
      bboxForShape(
        center,
        shape,
        size.widthInches,
        size.heightInches,
        rotation,
        newScale,
      ),
    );
  };

  /** Translate the shape (drag-from-inside the overlay). */
  const handleCenterChange = (newCenter: LngLat) => {
    if (!bbox) return;
    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    setBbox(
      bboxForShape(
        newCenter,
        shape,
        size.widthInches,
        size.heightInches,
        rotation,
        scale,
      ),
    );
  };

  /** Corner / perimeter handle drag — sets new shape dimensions in inches. */
  const handleShapeResize = (newWidthInches: number, newHeightInches: number) => {
    if (!bbox) return;
    // Enforce aspect lock for rectangles. The lock is equivalent to a
    // projection of the un-constrained (W, H) drag onto the W = H line:
    // both formulas agree on the average, so the simple form is right.
    let w = newWidthInches;
    let h = newHeightInches;
    if (shape === "rectangle" && size.aspectLocked) {
      const avg = (w + h) / 2;
      w = avg;
      h = avg;
    }
    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    const center = bboxCenter(bbox);
    setBbox(bboxForShape(center, shape, w, h, rotation, scale));
    setSize((s) => ({
      ...s,
      widthInches: w,
      heightInches: h,
    }));
  };

  const handleRotationChange = (newRotation: number) => {
    if (!bbox) return;
    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    const center = bboxCenter(bbox);
    setRotation(newRotation);
    setBbox(
      bboxForShape(
        center,
        shape,
        size.widthInches,
        size.heightInches,
        newRotation,
        scale,
      ),
    );
  };

  /** Shape change — adjust heightInches per new shape rules; refit bbox. */
  const handleShapeChange = (newShape: Shape) => {
    if (!bbox) return;
    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    let newW = size.widthInches;
    let newH = size.heightInches;
    let newRot = rotation;
    if (newShape === "circle") {
      newH = newW;
      newRot = 0;
    } else if (newShape === "hexagon") {
      newH = newW * HEX_FLAT_TO_LONG;
    } else if (size.aspectLocked) {
      newH = newW;
    }
    setShape(newShape);
    setRotation(newRot);
    setSize((s) => ({ ...s, widthInches: newW, heightInches: newH }));
    const center = bboxCenter(bbox);
    setBbox(bboxForShape(center, newShape, newW, newH, newRot, scale));
  };

  const handleSizeChange = (newSize: SizeState) => {
    if (!bbox) {
      setSize(newSize);
      return;
    }
    // Coercion: enforce shape-specific aspect.
    let w = newSize.widthInches;
    let h = newSize.heightInches;
    if (shape === "circle") h = w;
    else if (shape === "hexagon") h = w * HEX_FLAT_TO_LONG;
    else if (newSize.aspectLocked) h = w;

    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    const center = bboxCenter(bbox);
    setBbox(bboxForShape(center, shape, w, h, rotation, scale));
    setSize({ ...newSize, widthInches: w, heightInches: h });
  };

  const handleGenerate = async () => {
    if (!bbox) return;
    setError(null);
    setView("loading");
    try {
      const payload: ElevationRequest = {
        bbox,
        gridSize,
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
        shape,
        rotation,
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

        <ShapeControls shape={shape} onChange={handleShapeChange} />

        <SizeControls
          size={size}
          shape={shape}
          rotation={rotation}
          onChange={handleSizeChange}
          bbox={bbox}
          onShapeWidthMetersChange={handleShapeWidthMetersChange}
        />

        <DensityControls gridSize={gridSize} onChange={setGridSize} />

        <EngravingControls
          label={engraveLabel}
          brand={engraveBrand}
          onChange={({ label: l, brand: b }) => {
            setEngraveLabel(l);
            setEngraveBrand(b);
          }}
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
            shape={shape}
            widthInches={size.widthInches}
            heightInches={size.heightInches}
            rotation={rotation}
            onCenterChange={handleCenterChange}
            onResize={handleShapeResize}
            onRotationChange={handleRotationChange}
            flyTo={flyTo}
          />
        )}
        {view === "viewer" && snapshot && (
          <ModelViewer
            bbox={snapshot.bbox}
            shape={snapshot.shape}
            rotation={snapshot.rotation}
            data={snapshot.data}
            widthInches={snapshot.widthInches}
            heightInches={snapshot.heightInches}
            baseThicknessInches={size.baseThicknessInches}
            verticalExaggeration={size.verticalExaggeration}
            engraveLabel={engraveLabel}
            engraveBrand={engraveBrand}
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
