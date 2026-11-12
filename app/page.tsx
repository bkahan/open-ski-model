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
//   - "Resort" is not a frame the user sets. The footprint is the picked
//     ski area's own outline, and the frame behind it (the terrain that
//     gets sampled) is fitted to the resort's lines and never shown, so
//     it cannot be dragged or sized to cut the resort off.
//   - `size` and `bbox` are a layout: what ground is covered and in what
//     proportions. `sizing` says whether the size or the scale is the
//     thing set, and `frame` (printFrame) is what the model is built at.
//     Frame edits all work on the layout; only what is generated, drawn
//     as an outline or read out uses `frame`.
//   - URL search params mirror this state so a deep link reopens the
//     same view.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import DensityControls from "@/components/DensityControls";
import EngravingControls from "@/components/EngravingControls";
import ResortControls from "@/components/ResortControls";
import SearchBar, { resortToResult } from "@/components/SearchBar";
import ShapeControls from "@/components/ShapeControls";
import SizeControls, { type SizeState } from "@/components/SizeControls";
import { useResortOutline } from "@/components/useResortOutline";
import {
  bboxCenter,
  bboxContains,
  bboxFromCenterWH,
  bboxWidthMeters,
  ensureBboxMinSize,
  scaleBbox,
  snapBboxToAspect,
} from "@/lib/bbox";
import type {
  ElevationRequest,
  ElevationResponse,
} from "@/lib/elevation/types";
import { resolveColorScheme } from "@/lib/resort/colors";
import {
  clampRunWidth,
  DEFAULT_RESORT_SETTINGS,
  type ResortSettings,
} from "@/lib/resort/settings";
import { ESTIMATED_OUTLINE_SHARE, type OutlineSpec } from "@/lib/mesh/resort-outline";
import type { ResortData, ResortRequest } from "@/lib/resort/types";
import {
  HEX_FLAT_TO_LONG,
  shapeAABBHalf,
  shapeIsRotatable,
  type Shape,
} from "@/lib/shape";
import { frameAroundResort, OUTLINE_FRAME_PADDING } from "@/lib/resort/frame";
import { lookupPlace, placeFromIndex, placeLine, resortBasePoint } from "@/lib/resort/place";
import {
  clampScaleDenominator,
  DEFAULT_RELIEF_INCHES,
  exaggerationForRelief,
  fitDragToPrint,
  printFrame,
  reliefForRescaledPrint,
  reliefForResizedPrint,
  denominatorForMetersPerInch,
  tooLargeToBuild,
  scaleForResizedPrint,
  type Sizing,
} from "@/lib/print-fit";
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

const DEFAULT_SHAPE_WIDTH_METERS = 5_000;
/**
 * What a first visit opens on: Jay Peak, as the ski-area index lists it,
 * framed the way a search pick would be. A plain frame at a fixed center
 * sat off to one side of the resort and cut its west edge off.
 */
const DEFAULT_RESORT = resortToResult({
  id: "e1a32fce69402dd1c018c22b0216990d077531fa",
  name: "Jay Peak Resort",
  location: "Vermont, United States",
  countryCode: "US",
  convention: "north_america",
  center: [-72.512278, 44.935604],
  bearing: 271.87,
  widthMeters: 3516,
  heightMeters: 3429,
  runCount: 79,
});
const DEFAULT_GRID_SIZE = 256;
const MIN_GRID_SIZE = 64;
const MAX_GRID_SIZE = 2048;

// Resort data is fetched for an area larger than the frame so small drags
// reuse it; a search looks wider still, since Nominatim's bbox for a
// summit is a point.
const RESORT_FETCH_SCALE = 1.6;
const RESORT_SEARCH_MIN_METERS = 8_000;
const RESORT_FRAME_PADDING = 1.08;
const RESORT_FRAME_MIN_RUNS = 3;
const RESORT_FETCH_DEBOUNCE_MS = 700;
/** Mirrors the server cap in /api/resort. */
const RESORT_MAX_FETCH_DEG = 1;

/**
 * The side the map's outline is traced at. The outline is built in
 * proportion to its frame, so on the ground it is the same ring at any
 * print size, give or take tolerances far finer than a map shows. Tracing
 * at one size means a size or scale change never retraces it.
 */
const OUTLINE_TRACE_INCHES = 6;

const RESORT_LINES_FAILED =
  "Couldn't load this resort's runs, so it is shown as a plain frame. Choose Resort to try again.";

type View = "map" | "loading" | "viewer";

/** The resort the Resort shape is about, kept so the shape can be gone back to. */
interface ResortPick {
  id: string;
  /** Where to look for its lines. */
  bbox: Bbox;
  /** Frame rotation that turns the resort's base toward the viewer. */
  rotation: number;
}

/** Index bearings run clockwise from north; frame rotation is positive counter-clockwise. */
function rotationForBearing(bearing: number): number {
  return ((Math.round(-bearing) % 360) + 360) % 360;
}

/** Area to fetch for a frame: padded for drag headroom, unless padding would exceed the API cap. */
function resortFetchArea(bbox: Bbox): Bbox {
  const scaled = scaleBbox(bbox, RESORT_FETCH_SCALE);
  const tooBig = scaled[2] - scaled[0] > RESORT_MAX_FETCH_DEG || scaled[3] - scaled[1] > RESORT_MAX_FETCH_DEG;
  return tooBig ? bbox : scaled;
}

async function fetchResort(bbox: Bbox, signal?: AbortSignal): Promise<ResortData> {
  const payload: ResortRequest = { bbox };
  const res = await fetch("/api/resort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ResortData;
}

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
    plinthLiftInches: 0,
    reliefInches: DEFAULT_RELIEF_INCHES,
    aspectLocked: true,
  });
  const [sizing, setSizing] = useState<Sizing>({ mode: "size" });
  const [shape, setShape] = useState<Shape>("rectangle");
  const [silhouette, setSilhouette] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [resortPick, setResortPick] = useState<ResortPick | null>(null);
  /** True from picking a resort until its frame has been fitted to its lines. */
  const [resortFitting, setResortFitting] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [gridSize, setGridSize] = useState<number>(DEFAULT_GRID_SIZE);
  const [engraveLabel, setEngraveLabel] = useState<boolean>(false);
  const [engraveBrand, setEngraveBrand] = useState<boolean>(true);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [flyTo, setFlyTo] = useState<LngLat | null>(null);
  const [label, setLabel] = useState<string | undefined>("Jay Peak");
  const [place, setPlace] = useState("");
  const [view, setView] = useState<View>("map");
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resortSettings, setResortSettings] = useState<ResortSettings>(DEFAULT_RESORT_SETTINGS);
  const [resort, setResort] = useState<ResortData | null>(null);
  const [resortLoading, setResortLoading] = useState(false);
  const [resortError, setResortError] = useState<string | null>(null);
  const resortAbortRef = useRef<AbortController | null>(null);
  const didHydrateFromUrl = useRef(false);
  /** What the first render has to pick once handlers exist: the default resort, or a link's. */
  const startRef = useRef<{ pick: ResortPick | "default"; followConnected: boolean } | null>(null);
  // Latest value for loadResort, which is created once.
  const silhouetteRef = useRef(silhouette);
  useEffect(() => {
    silhouetteRef.current = silhouette;
  });

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

    // A link that names its ski area can always go (back) to the Resort
    // shape. The shape is an outline of one area, so a link asking for it
    // without naming one opens as a plain frame.
    const linkPick = parsed.areaId && parsed.bbox ? { id: parsed.areaId, bbox: parsed.bbox, rotation: rot } : null;
    const resortShape = sh === "rectangle" && (parsed.silhouette ?? false) && linkPick !== null;
    setShape(sh);
    setSilhouette(resortShape);
    setResortPick(linkPick);
    setAreaId(parsed.areaId ?? null);
    setRotation(rot);
    setSize({
      widthInches: w,
      heightInches: h,
      baseThicknessInches: parsed.baseThicknessInches ?? 0.25,
      plinthLiftInches: parsed.plinthLiftInches ?? 0,
      reliefInches: parsed.reliefInches ?? DEFAULT_RELIEF_INCHES,
      aspectLocked: locked,
    });
    setSizing(
      typeof parsed.scaleDenominator === "number"
        ? { mode: "scale", denominator: parsed.scaleDenominator }
        : { mode: "size" },
    );
    const nextGridSize = parsed.gridSize !== undefined
      ? Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, parsed.gridSize))
      : DEFAULT_GRID_SIZE;
    setGridSize(nextGridSize);
    setEngraveLabel(parsed.engraveLabel ?? false);
    setEngraveBrand(parsed.engraveBrand ?? true);
    setResortSettings({
      showRuns: parsed.showRuns ?? DEFAULT_RESORT_SETTINGS.showRuns,
      showLifts: parsed.showLifts ?? DEFAULT_RESORT_SETTINGS.showLifts,
      followConnected: parsed.followConnected ?? DEFAULT_RESORT_SETTINGS.followConnected,
      minRunWidthMm: clampRunWidth(parsed.minRunWidthMm ?? DEFAULT_RESORT_SETTINGS.minRunWidthMm),
      colorScheme: parsed.colorScheme ?? DEFAULT_RESORT_SETTINGS.colorScheme,
    });
    setLabel(parsed.label ?? "Jay Peak");
    setPlace(parsed.place ?? "");
    setBbox(parsed.bbox ?? null);
    setFlyTo(parsed.bbox ? bboxCenter(parsed.bbox) : null);
    // A first visit has no frame to restore and opens on the default
    // resort. A Resort link's frame is not trusted either: it may have
    // been dragged or sized before frames were fitted, so it is refitted.
    // The setting rides along: the handlers the start effect calls are the
    // first render's, from before any of this state is in.
    const followConnected = parsed.followConnected ?? DEFAULT_RESORT_SETTINGS.followConnected;
    startRef.current = !parsed.bbox
      ? { pick: "default", followConnected }
      : resortShape
        ? { pick: linkPick, followConnected }
        : null;
  }, []);

  // --- Mirror state to URL whenever it stabilizes ---
  useEffect(() => {
    if (!bbox) return;
    const timer = setTimeout(() => {
      syncUrl({
        bbox,
        shape,
        silhouette,
        areaId,
        rotation,
        widthInches: size.widthInches,
        heightInches: size.heightInches,
        baseThicknessInches: size.baseThicknessInches,
        plinthLiftInches: size.plinthLiftInches,
        reliefInches: size.reliefInches,
        aspectLocked: size.aspectLocked,
        scaleDenominator: sizing.mode === "scale" ? sizing.denominator : null,
        gridSize,
        engraveLabel,
        engraveBrand,
        ...resortSettings,
        label,
        place,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [bbox, shape, silhouette, areaId, rotation, size, sizing, gridSize, engraveLabel, engraveBrand, resortSettings, label, place]);

  /** Fetch runs + lifts for `area`, replacing any in-flight request. */
  const loadResort = useCallback(async (area: Bbox): Promise<ResortData | null> => {
    resortAbortRef.current?.abort();
    const ctrl = new AbortController();
    resortAbortRef.current = ctrl;
    setResortLoading(true);
    setResortError(null);
    try {
      const data = await fetchResort(area, ctrl.signal);
      if (ctrl.signal.aborted) return null;
      setResort(data);
      return data;
    } catch (err) {
      if (ctrl.signal.aborted) return null;
      console.error("[resort]", err);
      setResortError(err instanceof Error ? err.message : "resort lookup failed");
      if (silhouetteRef.current) {
        // No lines, no outline: don't leave the Resort shape waiting on them.
        setSilhouette(false);
        setError(RESORT_LINES_FAILED);
      }
      return null;
    } finally {
      if (resortAbortRef.current === ctrl) setResortLoading(false);
    }
  }, []);

  useEffect(() => () => resortAbortRef.current?.abort(), []);

  // --- Keep resort data covering the current frame ---
  // Waits for any in-flight load rather than replacing it: a search
  // moves the frame and then fetches, and this must not abort that.
  // When the load lands, `resort` changes and this re-checks coverage.
  // One attempt per frame: a failed lookup shows its error and waits for
  // the user to move the frame, rather than hammering Overpass.
  const attemptedBboxRef = useRef<Bbox | null>(null);
  useEffect(() => {
    // The outline is made of the lines, so the Resort shape needs them
    // whether or not runs are shown.
    if (!bbox || (!resortSettings.showRuns && !silhouette) || resortLoading) return;
    // A resort being fitted fetches its own lines and moves the frame when they land.
    if (resortFitting) return;
    if (resort && bboxContains(resort.bbox, bbox)) return;
    if (attemptedBboxRef.current === bbox) return;
    const timer = setTimeout(() => {
      attemptedBboxRef.current = bbox;
      void loadResort(resortFetchArea(bbox));
    }, RESORT_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [bbox, resort, resortLoading, resortFitting, resortSettings.showRuns, silhouette, loadResort]);

  // The resort whose town is still being looked up for the plate's second
  // line. A newer pick, or the user going to edit the line, drops it.
  const placeLookupRef = useRef<string | null>(null);

  // Latest bbox for async handlers that must not clobber newer edits.
  const bboxRef = useRef<Bbox | null>(bbox);
  useEffect(() => {
    bboxRef.current = bbox;
  }, [bbox]);

  // The outline the map shows: the ring the model will be cut to, traced
  // from the fitted frame and the lines that cover it.
  const outlineSpec = useMemo<OutlineSpec | null>(() => {
    if (!silhouette || resortFitting || !bbox || !areaId) return null;
    if (!resort || !bboxContains(resort.bbox, bbox)) return null;
    return {
      bbox,
      shape: "rectangle",
      widthInches: OUTLINE_TRACE_INCHES,
      heightInches: OUTLINE_TRACE_INCHES,
      rotation,
      resort,
      areaId,
      followConnected: resortSettings.followConnected,
      gridColumns: gridSize,
    };
  }, [silhouette, resortFitting, bbox, areaId, resort, rotation, gridSize, resortSettings.followConnected]);
  const outline = useResortOutline(outlineSpec);
  /**
   * The Resort shape has nothing to generate from until its outline is
   * traced: the frame to build is sized off that trace, so one still out
   * for a turned or re-gridded frame holds Generate too.
   */
  const resortPending = silhouette && (outlineSpec === null || !outline.settled);
  // A resort with nothing to trace is built as its plain frame, so the
  // size set is the frame's. Until a trace is back the usual share stands in.
  const nothingToTrace = outlineSpec !== null && outline.settled && outline.ring === null;
  const mountainShare = !silhouette || nothingToTrace ? null : (outline.share ?? ESTIMATED_OUTLINE_SHARE);

  // What the model is built at. The panel's size is the mountain's for a
  // resort, so its frame is that much bigger; at a set scale the size
  // follows from the ground covered.
  const frame = useMemo(() => {
    if (!bbox) return null;
    return printFrame({
      size: { widthInches: size.widthInches, heightInches: size.heightInches },
      metersPerInch: scaleMPerIn(bbox, shape, size.widthInches, size.heightInches, rotation),
      sizing,
      outlineShare: mountainShare,
    });
  }, [bbox, shape, size.widthInches, size.heightInches, rotation, sizing, mountainShare]);
  const frameTooBig = frame !== null && tooLargeToBuild(frame);

  const resolvedScheme = useMemo(
    () => resolveColorScheme(resortSettings.colorScheme, bbox ?? [0, 0, 0, 0], resort?.convention ?? null),
    [resortSettings.colorScheme, bbox, resort?.convention],
  );

  // All bbox refits are done inside the explicit handlers (handleShapeChange,
  // handleSizeChange, etc.) since they already know the old state. We
  // intentionally do NOT auto-refit in an effect — that would race with
  // the handlers and compute scale from stale references.

  const exaggeration = useMemo(() => {
    if (!snapshot) return null;
    const metersPerInch = scaleMPerIn(
      snapshot.bbox,
      snapshot.shape,
      snapshot.widthInches,
      snapshot.heightInches,
      snapshot.rotation,
    );
    // The panel's print size can run ahead of the model on screen until
    // the next Regenerate, so the height is read at the model's own size.
    return exaggerationForRelief(
      reliefForResizedPrint(frame ?? snapshot, snapshot, size.reliefInches),
      snapshot.data.max - snapshot.data.min,
      1 / metersPerInch,
    );
  }, [snapshot, frame, size.reliefInches]);

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

  /**
   * Auto-frame: look for runs around a search result and fit the frame
   * to them. Keeps the center-on-result frame when the area has none, or
   * when the user has moved the frame while the lookup was running.
   */
  const autoFrameResort = async (result: SearchResult, initialBbox: Bbox) => {
    const searchArea = ensureBboxMinSize(result.bbox, RESORT_SEARCH_MIN_METERS);
    const data = await loadResort(searchArea);
    if (!data?.extent || data.runs.length < RESORT_FRAME_MIN_RUNS) return;
    if (bboxRef.current !== initialBbox) return;
    const framed = snapBboxToAspect(
      scaleBbox(data.extent, RESORT_FRAME_PADDING),
      aabbAspect,
      0,
    );
    setBbox(framed);
    setFlyTo(bboxCenter(framed));
  };

  // The pick whose frame is being fitted. A newer pick, or leaving the
  // Resort shape, makes an older fit's answer stale.
  const resortFitRef = useRef<symbol | null>(null);

  /**
   * Makes the Resort shape about `pick`: a square frame turned to the
   * resort's bearing and fitted around its own lines. Until the lines are
   * in there is no outline to show, and nothing is generated from the
   * index's rough viewport, which can sit off-center and cut runs off.
   * `followConnected` is passed in, not read from the settings: the
   * callers that change it, or load it from a link, have it before the
   * state does.
   */
  const frameResort = (pick: ResortPick, lines: Promise<ResortData>, followConnected: boolean) => {
    const fit = Symbol("resort fit");
    resortFitRef.current = fit;
    const side = size.widthInches;
    setShape("rectangle");
    setSilhouette(true);
    setAreaId(pick.id);
    setResortPick(pick);
    setRotation(pick.rotation);
    setSize((s) => ({ ...s, heightInches: s.widthInches }));
    setBbox(snapBboxToAspect(scaleBbox(pick.bbox, RESORT_FRAME_PADDING), 1, 0));
    setResortFitting(true);
    setError(null);

    const frameFor = (data: ResortData): { center: LngLat; bbox: Bbox } | null => {
      const frame = frameAroundResort(data, pick.id, pick.rotation, OUTLINE_FRAME_PADDING, { followConnected });
      if (!frame) return null;
      return {
        center: frame.center,
        bbox: bboxForShape(frame.center, "rectangle", side, side, pick.rotation, frame.sideMeters / side),
      };
    };
    const fitted = async () => {
      const first = await lines;
      const frame = frameFor(first);
      if (!frame || bboxContains(first.bbox, frame.bbox)) return { data: first, frame };
      // Lines fetched around the index's viewport stopped short of the
      // frame they led to. The lines that cover it are the ones the
      // outline is traced from, and they may reach further, so the frame
      // is fitted to those.
      const wider = await fetchResort(resortFetchArea(frame.bbox));
      return { data: wider, frame: frameFor(wider) ?? frame };
    };

    fitted()
      .then(({ data, frame }) => {
        if (resortFitRef.current !== fit) return;
        setResortFitting(false);
        if (!frame) {
          // Nothing carries this ski area's tag, so there is nothing to outline.
          setSilhouette(false);
          setAreaId(null);
          setResortPick(null);
          setError("No runs are mapped for this resort, so it is shown as a plain frame.");
          return;
        }
        setBbox(frame.bbox);
        setFlyTo(frame.center);
        // The same lines draw the outline: skip another request when they cover the frame.
        if (bboxContains(data.bbox, frame.bbox)) setResort(data);
      })
      .catch((err: unknown) => {
        console.error("[resort-frame]", err);
        if (resortFitRef.current !== fit) return;
        setResortFitting(false);
        setSilhouette(false);
        setError(RESORT_LINES_FAILED);
      });
  };

  /**
   * Looks the picked resort's town up, once: at its base area when its
   * lines say where that is, at its center when they don't or didn't load.
   */
  const fillPlace = async (result: SearchResult, lines: Promise<ResortData>) => {
    const data = await lines.catch(() => null);
    if (placeLookupRef.current !== result.id) return;
    const point = (data && resortBasePoint(data, result.id)) ?? result.center;
    const parts = await lookupPlace(point);
    if (placeLookupRef.current !== result.id) return;
    placeLookupRef.current = null;
    if (parts?.town) setPlace(placeLine(parts));
  };

  const handleSearch = (result: SearchResult, followConnected = resortSettings.followConnected) => {
    setLabel(result.name);
    // The index's own idea of the place shows at once. Its towns are often
    // a hamlet or the next town over, so fillPlace replaces it.
    setPlace(result.kind === "resort" ? placeLine(placeFromIndex(result.location ?? null, result.countryCode ?? null)) : "");
    placeLookupRef.current = result.kind === "resort" ? result.id : null;
    setFlyTo(result.center);

    if (result.kind === "resort") {
      // Resorts open as their own outline with the name on it.
      setEngraveLabel(true);
      const lines = fetchResort(resortFetchArea(result.bbox));
      frameResort(
        {
          id: result.id,
          bbox: result.bbox,
          rotation: result.bearing !== undefined ? rotationForBearing(result.bearing) : rotation,
        },
        lines,
        followConnected,
      );
      fillPlace(result, lines).catch((err: unknown) => {
        if (placeLookupRef.current === result.id) placeLookupRef.current = null;
        console.warn("[place] lookup failed", err);
      });
      return;
    }

    // A place is not a ski area: it gets a plain frame, and the Resort
    // shape has nothing to go back to.
    resortFitRef.current = null;
    setResortFitting(false);
    setSilhouette(false);
    setAreaId(null);
    setResortPick(null);
    const initial = snapBboxToAspect(result.bbox, aabbAspect, DEFAULT_SHAPE_WIDTH_METERS);
    setBbox(initial);
    if (resortSettings.showRuns) {
      autoFrameResort(result, initial).catch((err) => console.error("[auto-frame]", err));
    }
  };

  // What the link asked the first render for (see the hydrate effect): the
  // default resort, picked as a search would, or the link's own, refitted.
  const startHandlersRef = useRef({ handleSearch, frameResort });
  useEffect(() => {
    startHandlersRef.current = { handleSearch, frameResort };
  });
  useEffect(() => {
    const start = startRef.current;
    startRef.current = null;
    if (!start) return;
    if (start.pick === "default") startHandlersRef.current.handleSearch(DEFAULT_RESORT, start.followConnected);
    else startHandlersRef.current.frameResort(start.pick, fetchResort(resortFetchArea(start.pick.bbox)), start.followConnected);
  }, []);

  /** "Box width (km)" — sets the SHAPE's real-world width. */
  const handleShapeWidthMetersChange = (widthMeters: number) => {
    // The Resort shape's ground is the resort's, not a width to set.
    if (!bbox || silhouette) return;
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
    // A moved frame is no longer about the resort that was picked.
    setAreaId(null);
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

  /**
   * Corner / perimeter handle drag. The drag decides what ground the frame
   * covers; the print keeps its size and the map scale changes instead.
   */
  const handleShapeResize = (
    newWidthInches: number,
    newHeightInches: number,
    newCenter?: LngLat,
  ) => {
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
    const fitted = fitDragToPrint({ widthInches: w, heightInches: h }, size, scale);
    if (!fitted) return;
    setBbox(
      bboxForShape(
        newCenter ?? bboxCenter(bbox),
        shape,
        fitted.widthInches,
        fitted.heightInches,
        rotation,
        fitted.metersPerInch,
      ),
    );
    setSize((s) => ({
      ...s,
      widthInches: fitted.widthInches,
      heightInches: fitted.heightInches,
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
    resortFitRef.current = null;
    setResortFitting(false);
    setSilhouette(false);
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

  /**
   * To the picked resort's outline, refitted: the frame may have been
   * moved off it in another shape, and a click while already on Resort is
   * the way to retry lines that failed to load.
   */
  const handleSilhouette = () => {
    if (!resortPick) return;
    frameResort(resortPick, fetchResort(resortFetchArea(resortPick.bbox)), resortSettings.followConnected);
  };

  /** Which runs count as the resort's decides its frame, so that change refits it. */
  const handleResortSettingsChange = (next: ResortSettings) => {
    setResortSettings(next);
    if (next.followConnected !== resortSettings.followConnected && silhouette && resortPick) {
      const area = resortFetchArea(resortPick.bbox);
      // The lines already loaded for this resort say which ones join it.
      const lines = resort && bboxContains(resort.bbox, area) ? Promise.resolve(resort) : fetchResort(area);
      frameResort(resortPick, lines, next.followConnected);
    }
  };

  const handleSizeChange = (newSize: SizeState) => {
    if (!bbox) {
      setSize(newSize);
      return;
    }
    // Coercion: enforce shape-specific aspect. The Resort shape's hidden
    // frame stays square, as it was fitted.
    let w = newSize.widthInches;
    let h = newSize.heightInches;
    if (shape === "circle" || silhouette) h = w;
    else if (shape === "hexagon") h = w * HEX_FLAT_TO_LONG;
    else if (newSize.aspectLocked) h = w;

    const scale = scaleMPerIn(
      bbox,
      shape,
      size.widthInches,
      size.heightInches,
      rotation,
    );
    const next = { widthInches: w, heightInches: h };
    const center = bboxCenter(bbox);
    setBbox(
      bboxForShape(center, shape, w, h, rotation, scaleForResizedPrint(size, next, scale)),
    );
    setSize({
      ...newSize,
      ...next,
      reliefInches: reliefForResizedPrint(size, next, newSize.reliefInches),
    });
  };

  /**
   * Switching what is set keeps the print as it is: the size starts from
   * the scale's, and the scale from the one the size had led to. Only a
   * size whose scale is outside what can be set moves, to the nearest
   * scale that can, and the model height goes with it.
   */
  const handleSizingModeChange = (mode: Sizing["mode"]) => {
    if (mode === sizing.mode || !frame) return;
    if (mode === "scale") {
      const current = denominatorForMetersPerInch(frame.metersPerInch);
      const next = clampScaleDenominator(current);
      setSizing({ mode: "scale", denominator: next });
      setSize((s) => ({ ...s, reliefInches: reliefForRescaledPrint(s.reliefInches, current, next) }));
      return;
    }
    setSizing({ mode: "size" });
    setSize((s) => ({ ...s, widthInches: frame.stated.widthInches, heightInches: frame.stated.heightInches }));
  };

  /** A new scale for the same ground: the print resizes, and the model height with it. */
  const handleScaleChange = (denominator: number) => {
    const next = clampScaleDenominator(denominator);
    if (sizing.mode === "scale") {
      const previous = sizing.denominator;
      setSize((s) => ({ ...s, reliefInches: reliefForRescaledPrint(s.reliefInches, previous, next) }));
    }
    setSizing({ mode: "scale", denominator: next });
  };

  const handleGenerate = async () => {
    if (!bbox || !frame) return;
    setError(null);
    setView("loading");
    try {
      const payload: ElevationRequest = {
        bbox,
        gridSize,
        source: "auto",
      };
      // Make sure the runs cover the frame being generated; the map-time
      // fetch may be stale after a quick drag. Not awaited: the viewer
      // picks the runs up when they land.
      if (resortSettings.showRuns && !resortLoading && !(resort && bboxContains(resort.bbox, bbox))) {
        attemptedBboxRef.current = bbox;
        void loadResort(resortFetchArea(bbox));
      }
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
        widthInches: frame.widthInches,
        heightInches: frame.heightInches,
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

        <ShapeControls
          shape={shape}
          silhouette={silhouette}
          resortAvailable={resortPick !== null}
          onChange={handleShapeChange}
          onSilhouette={handleSilhouette}
        />

        <SizeControls
          size={size}
          shape={shape}
          resortMode={silhouette}
          onPlinth={engraveLabel}
          rotation={rotation}
          onChange={handleSizeChange}
          sizing={sizing}
          onSizingModeChange={handleSizingModeChange}
          onScaleChange={handleScaleChange}
          frame={frame}
          bbox={bbox}
          exaggeration={view === "viewer" ? exaggeration : null}
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
          place={place}
          onPlaceEditStart={() => {
            placeLookupRef.current = null;
          }}
          onPlaceChange={(next) => {
            placeLookupRef.current = null;
            setPlace(next);
          }}
        />

        <ResortControls
          settings={resortSettings}
          onChange={handleResortSettingsChange}
          resortShape={silhouette}
          resort={resort}
          loading={resortLoading}
          error={resortError}
          onRetry={() => {
            if (bbox) void loadResort(resortFetchArea(bbox));
          }}
          resolvedScheme={resolvedScheme}
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
            disabled={!bbox || resortPending || frameTooBig}
            className="w-full rounded-md bg-amber-400 text-slate-950 font-semibold py-2.5 text-sm hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {resortPending ? "Loading resort\u2026" : frameTooBig ? "Too large to build" : "Generate 3D model"}
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
            Elevation: AWS Terrain Tiles, USGS 3DEP. Ski runs and lifts:
            data from{" "}
            <a href="https://openskidata.org" className="underline" target="_blank" rel="noreferrer">
              OpenSkiData / OpenSkiMap.org
            </a>
            , © OpenStreetMap contributors (ODbL), Skimap.org, Who&apos;s On
            First, © Mapterhorn.
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
            resort={resortSettings.showRuns ? resort : null}
            colorScheme={resolvedScheme}
            showLifts={resortSettings.showLifts}
            outline={silhouette ? outline.ring : null}
            outlineId={silhouette ? areaId : null}
            frameHidden={silhouette}
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
            plinthLiftInches={size.plinthLiftInches}
            verticalExaggeration={exaggeration ?? 1}
            engraveLabel={engraveLabel}
            engraveBrand={engraveBrand}
            label={snapshot.label}
            place={place}
            resort={resort}
            silhouette={silhouette}
            areaId={areaId}
            followConnected={resortSettings.followConnected}
            showRuns={resortSettings.showRuns}
            colorScheme={resolvedScheme}
            showLifts={resortSettings.showLifts}
            minRunWidthMm={resortSettings.minRunWidthMm}
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
