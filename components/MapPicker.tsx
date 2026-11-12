"use client";

// Interactive 2D map with a directly-manipulable SHAPE on top.
//
// Mental model:
//   - The shape (rectangle, circle, hexagon) lives in a model-plane frame
//     centered at the shape's geographic center. Its pre-rotation
//     dimensions are widthInches × heightInches; rotation is applied
//     around the center.
//   - The map's MapLibre canvas projects geographic coordinates to
//     pixels. We use map.project / map.unproject to convert between
//     model-plane (inches → meters → lng/lat → screen px) for drawing
//     the shape outline and positioning handles.
//   - The bbox AABB that's passed in is the AABB of the rotated shape;
//     we use it only to derive the scale (m/inch) at the current view.
//   - Drag interactions:
//       · Drag inside the shape outline → translate (onCenterChange).
//       · Drag a corner handle (rectangle) → resize; the opposite corner
//         is the anchor.
//       · Drag the perimeter handle (circle / hex) → change diameter.
//       · Drag the rotation handle → rotate around center.
//   - A resort's outline replaces all of that: `outline` is drawn as a
//     map layer and, with `frameHidden`, the shape and its handles are
//     not shown, so there is nothing to drag.

import type { FeatureCollection, Polygon } from "geojson";
import maplibregl, { type GeoJSONSource, type Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { bboxCenter, bboxWidthMeters, metersPerDegLng } from "@/lib/bbox";
import type { ColorScheme } from "@/lib/resort/colors";
import {
  EMPTY_RESORT_GEOJSON,
  resortToGeoJSON,
  type ResortFeatureCollection,
} from "@/lib/resort/geojson";
import type { ResortData } from "@/lib/resort/types";
import { shapeAABBHalf, shapeIsRotatable, type Shape } from "@/lib/shape";
import type { Bbox, LngLat } from "@/lib/types";

const METERS_PER_DEG_LAT = 111_320;

/** Pixel margin from shape edge to the rotation handle. */
const ROTATION_HANDLE_OFFSET_PX = 28;

const RESORT_SOURCE = "resort";
const RUN_LAYER = "resort-runs";
const LIFT_LAYER = "resort-lifts";
const OUTLINE_SOURCE = "resort-outline";
const OUTLINE_FILL_LAYER = "resort-outline-fill";
const OUTLINE_EDGE_LAYER = "resort-outline-edge";
const OUTLINE_COLOR = "#f5b942";
/** Room left around an outline when the map is moved to show all of it. */
const OUTLINE_FIT_PADDING_PX = 48;
const OUTLINE_FIT_MAX_ZOOM = 14;

interface Props {
  bbox: Bbox | null;
  shape: Shape;
  /** Shape's pre-rotation width in inches. */
  widthInches: number;
  /** Shape's pre-rotation height in inches. */
  heightInches: number;
  /** Degrees clockwise (in screen, where +z is north). */
  rotation: number;
  onCenterChange: (next: LngLat) => void;
  /** Sets new shape pre-rotation dimensions in inches. */
  /** A new shape in inches at the current map scale, and its center if that moved. */
  onResize: (widthInches: number, heightInches: number, center?: LngLat) => void;
  onRotationChange: (rotationDeg: number) => void;
  flyTo?: LngLat | null;
  /** Runs and lifts to draw under the shape overlay; null hides the layer. */
  resort: ResortData | null;
  colorScheme: ColorScheme;
  showLifts: boolean;
  /** The ring the model will be cut to, drawn in place of the shape; null draws none. */
  outline: LngLat[] | null;
  /** Which ski area the outline is of. The map moves to an outline once per area. */
  outlineId: string | null;
  /** Hides the shape and its handles: the footprint is the outline, not a frame to drag. */
  frameHidden: boolean;
}

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

const MAPTILER_STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
  : null;

const OPENTOPO_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    topo: {
      type: "raster",
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      maxzoom: 15,
      attribution:
        "© <a href=\"https://opentopomap.org\">OpenTopoMap</a> (CC-BY-SA) · © OpenStreetMap contributors",
    },
  },
  layers: [{ id: "topo", type: "raster", source: "topo" }],
};

/**
 * Convert a model-plane offset (inches in shape-local, un-rotated frame)
 * to a geographic point relative to `center`, applying rotation.
 *   +x = east (positive longitude)
 *   +z = north (positive latitude)
 */
function localToGeo(
  center: LngLat,
  xIn: number,
  zIn: number,
  rotationDeg: number,
  metersPerInch: number,
): LngLat {
  const θ = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  const rx = xIn * c - zIn * s;
  const rz = xIn * s + zIn * c;
  const rxM = rx * metersPerInch;
  const rzM = rz * metersPerInch;
  const dLng = rxM / metersPerDegLng(center[1]);
  const dLat = rzM / METERS_PER_DEG_LAT;
  return [center[0] + dLng, center[1] + dLat];
}

/**
 * Runs `apply` as soon as the style can take sources and layers, and
 * returns a way to stop waiting. isStyleLoaded() is no test for that: it
 * is false while any tile is still on its way, which on a slow connection
 * is most of the time, and waiting for "idle" waits for every tile. The
 * style itself says when it isn't ready, by throwing from addSource.
 */
function whenStyleReady(map: MlMap, apply: () => void): () => void {
  const attempt = () => {
    try {
      apply();
    } catch (err) {
      if (err instanceof Error && err.message.includes("not done loading")) return;
      throw err;
    }
    map.off("styledata", attempt);
  };
  map.on("styledata", attempt);
  attempt();
  return () => {
    map.off("styledata", attempt);
  };
}

/** Add the resort source + layers once; later calls are no-ops. */
function ensureResortLayers(map: MlMap) {
  if (map.getSource(RESORT_SOURCE)) return;
  map.addSource(RESORT_SOURCE, { type: "geojson", data: EMPTY_RESORT_GEOJSON });
  map.addLayer({
    id: LIFT_LAYER,
    type: "line",
    source: RESORT_SOURCE,
    filter: ["==", ["get", "kind"], "lift"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 2,
      "line-dasharray": [2, 1.5],
    },
  });
  map.addLayer({
    id: RUN_LAYER,
    type: "line",
    source: RESORT_SOURCE,
    filter: ["==", ["get", "kind"], "run"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 3,
      "line-opacity": 0.9,
    },
  });
}

type OutlineGeoJSON = FeatureCollection<Polygon>;

function outlineGeoJSON(ring: LngLat[] | null): OutlineGeoJSON {
  if (!ring || ring.length < 3) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      },
    ],
  };
}

/** Add the outline source + layers once, under the runs when those exist. */
function ensureOutlineLayers(map: MlMap) {
  if (map.getSource(OUTLINE_SOURCE)) return;
  const under = map.getLayer(LIFT_LAYER) ? LIFT_LAYER : undefined;
  map.addSource(OUTLINE_SOURCE, { type: "geojson", data: outlineGeoJSON(null) });
  map.addLayer(
    {
      id: OUTLINE_FILL_LAYER,
      type: "fill",
      source: OUTLINE_SOURCE,
      paint: { "fill-color": OUTLINE_COLOR, "fill-opacity": 0.12 },
    },
    under,
  );
  map.addLayer(
    {
      id: OUTLINE_EDGE_LAYER,
      type: "line",
      source: OUTLINE_SOURCE,
      layout: { "line-join": "round" },
      paint: { "line-color": OUTLINE_COLOR, "line-width": 2 },
    },
    under,
  );
}

/** Convert window-relative pointer coords to map-container-relative px. */
function cursorContainerPx(
  e: PointerEvent,
  container: HTMLElement | null,
): [number, number] {
  if (!container) return [e.clientX, e.clientY];
  const rect = container.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

/** Inverse of localToGeo: take a geographic offset and return un-rotated shape-local inches. */
function geoToLocal(
  center: LngLat,
  point: LngLat,
  rotationDeg: number,
  metersPerInch: number,
): [number, number] {
  const dLng = point[0] - center[0];
  const dLat = point[1] - center[1];
  const rxM = dLng * metersPerDegLng(center[1]);
  const rzM = dLat * METERS_PER_DEG_LAT;
  const rxIn = rxM / metersPerInch;
  const rzIn = rzM / metersPerInch;
  // Un-rotate.
  const θ = (-rotationDeg * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  return [rxIn * c - rzIn * s, rxIn * s + rzIn * c];
}

export default function MapPicker({
  bbox,
  shape,
  widthInches,
  heightInches,
  rotation,
  onCenterChange,
  onResize,
  onRotationChange,
  flyTo,
  resort,
  colorScheme,
  showLifts,
  outline,
  outlineId,
  frameHidden,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);

  // SVG + handle element refs.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);
  const shapePathRef = useRef<SVGPathElement | null>(null);
  const nwHandleRef = useRef<SVGCircleElement | null>(null);
  const seHandleRef = useRef<SVGCircleElement | null>(null);
  const perimHandleRef = useRef<SVGCircleElement | null>(null);
  const rotHandleRef = useRef<SVGCircleElement | null>(null);
  const rotLineRef = useRef<SVGLineElement | null>(null);

  // Latest-value mirrors so listeners (bound once on mount) see fresh
  // props/callbacks without needing to rebind. Synced post-render below.
  const bboxRef = useRef<Bbox | null>(bbox);
  const shapeRef = useRef<Shape>(shape);
  const widthRef = useRef(widthInches);
  const heightRef = useRef(heightInches);
  const rotationRef = useRef(rotation);
  const onCenterRef = useRef(onCenterChange);
  const onResizeRef = useRef(onResize);
  const onRotationRef = useRef(onRotationChange);

  useEffect(() => {
    bboxRef.current = bbox;
    shapeRef.current = shape;
    widthRef.current = widthInches;
    heightRef.current = heightInches;
    rotationRef.current = rotation;
    onCenterRef.current = onCenterChange;
    onResizeRef.current = onResize;
    onRotationRef.current = onRotationChange;
  });

  // Compute the SHAPE's metersPerInch from the current bbox AABB. Kept
  // around for potential future use (e.g. live readout of model scale).
  const metersPerInch = useMemo(() => {
    if (!bbox) return 0;
    const halfWIn = shapeAABBHalf(shape, widthInches, heightInches, rotation)[0];
    if (halfWIn === 0) return 0;
    return bboxWidthMeters(bbox) / (halfWIn * 2);
  }, [bbox, shape, widthInches, heightInches, rotation]);
  void metersPerInch;

  // --- Paint shape outline + handles in screen pixels ---
  // Reads everything from refs so identity stays stable across renders.
  const paintOverlay = useCallback(() => {
    const map = mapRef.current;
    const svg = svgRef.current;
    const group = groupRef.current;
    const b = bboxRef.current;
    if (!map || !svg || !group || !b) return;

    const sh = shapeRef.current;
    const w = widthRef.current;
    const h = heightRef.current;
    const rot = rotationRef.current;
    if (w <= 0 || h <= 0) return;

    const center = bboxCenter(b);
    const halfWIn = shapeAABBHalf(sh, w, h, rot)[0];
    const mPerIn = bboxWidthMeters(b) / (halfWIn * 2);

    // Project the shape's center to screen.
    const cPx = map.project(center);

    // For each shape-local offset, compute the screen pixel position
    // (this naturally includes rotation, since localToGeo applies it).
    const projLocal = (xIn: number, zIn: number) => {
      const geo = localToGeo(center, xIn, zIn, rot, mPerIn);
      return map.project(geo);
    };

    // Un-rotated shape outline path in shape-local inches, then projected.
    let path = "";
    if (sh === "rectangle") {
      const corners: Array<[number, number]> = [
        [-w / 2, -h / 2],
        [+w / 2, -h / 2],
        [+w / 2, +h / 2],
        [-w / 2, +h / 2],
      ];
      path = corners
        .map(([x, z], i) => {
          const p = projLocal(x, z);
          return `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        })
        .join(" ") + " Z";
    } else if (sh === "circle") {
      const R = w / 2;
      const N = 64;
      const pts: string[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const p = projLocal(R * Math.cos(a), R * Math.sin(a));
        pts.push(`${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`);
      }
      path = pts.join(" ") + " Z";
    } else if (sh === "hexagon") {
      const R = w / 2;
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const p = projLocal(R * Math.cos(a), R * Math.sin(a));
        pts.push(`${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`);
      }
      path = pts.join(" ") + " Z";
    }
    shapePathRef.current?.setAttribute("d", path);

    // Position handles — only the relevant ones; hide the rest.
    const setHandle = (
      el: SVGCircleElement | null,
      visible: boolean,
      xIn?: number,
      zIn?: number,
    ) => {
      if (!el) return;
      if (!visible) {
        el.setAttribute("visibility", "hidden");
        return;
      }
      el.removeAttribute("visibility");
      const p = projLocal(xIn ?? 0, zIn ?? 0);
      el.setAttribute("cx", p.x.toFixed(2));
      el.setAttribute("cy", p.y.toFixed(2));
    };

    if (sh === "rectangle") {
      // NW = (west, north) = (-W/2, +H/2). SE = (east, south) = (+W/2, -H/2).
      setHandle(nwHandleRef.current, true, -w / 2, +h / 2);
      setHandle(seHandleRef.current, true, +w / 2, -h / 2);
      setHandle(perimHandleRef.current, false);
    } else if (sh === "circle") {
      setHandle(nwHandleRef.current, false);
      setHandle(seHandleRef.current, false);
      setHandle(perimHandleRef.current, true, w / 2, 0);
    } else if (sh === "hexagon") {
      setHandle(nwHandleRef.current, false);
      setHandle(seHandleRef.current, false);
      setHandle(perimHandleRef.current, true, w / 2, 0);
    }

    // Rotation handle (above the top edge, perpendicular to it). Skip
    // for circle. "Top" = north (+z) since the map is north-up.
    if (shapeIsRotatable(sh)) {
      const topMidLocal: [number, number] =
        sh === "hexagon" ? [0, ((w / 2) * Math.sqrt(3)) / 2] : [0, +h / 2];
      const topPx = projLocal(topMidLocal[0], topMidLocal[1]);
      // The rotation-handle direction: outward from center through the
      // top midpoint. Project the center too so we have a normalized
      // outward direction in screen pixels.
      const dx = topPx.x - cPx.x;
      const dy = topPx.y - cPx.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const handleX = topPx.x + ux * ROTATION_HANDLE_OFFSET_PX;
      const handleY = topPx.y + uy * ROTATION_HANDLE_OFFSET_PX;
      const rotH = rotHandleRef.current;
      const rotL = rotLineRef.current;
      if (rotH) {
        rotH.removeAttribute("visibility");
        rotH.setAttribute("cx", handleX.toFixed(2));
        rotH.setAttribute("cy", handleY.toFixed(2));
      }
      if (rotL) {
        rotL.removeAttribute("visibility");
        rotL.setAttribute("x1", topPx.x.toFixed(2));
        rotL.setAttribute("y1", topPx.y.toFixed(2));
        rotL.setAttribute("x2", handleX.toFixed(2));
        rotL.setAttribute("y2", handleY.toFixed(2));
      }
    } else {
      rotHandleRef.current?.setAttribute("visibility", "hidden");
      rotLineRef.current?.setAttribute("visibility", "hidden");
    }
  }, []);

  // Repaint whenever the values paintOverlay reads change. paintOverlay
  // itself is stable so listing it in deps is a no-op.
  useEffect(() => {
    paintOverlay();
  }, [bbox, shape, widthInches, heightInches, rotation, paintOverlay]);

  // --- 1. Initialize the map once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAPTILER_STYLE_URL ?? OPENTOPO_STYLE,
      center: [-72.5, 44.93],
      zoom: 11,
      attributionControl: false,
    });
    map.on("error", (e) => {
      const err = (e as { error?: { message?: string } }).error;
      console.warn("[map error]", err?.message ?? e);
    });
    const resizeTimer = setTimeout(() => map.resize(), 100);
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right",
    );
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    mapRef.current = map;

    const repaint = () => paintOverlay();
    map.on("move", repaint);
    map.on("resize", repaint);
    map.once("load", repaint);

    return () => {
      clearTimeout(resizeTimer);
      map.off("move", repaint);
      map.off("resize", repaint);
      map.remove();
      mapRef.current = null;
    };
  }, [paintOverlay]);

  // --- 2. Fly to new search result ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo({ center: flyTo, zoom: Math.max(map.getZoom(), 12), duration: 800 });
  }, [flyTo]);

  // --- 2b. Runs + lifts layer ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const geojson: ResortFeatureCollection = resort
      ? resortToGeoJSON(resort, colorScheme, showLifts)
      : EMPTY_RESORT_GEOJSON;
    return whenStyleReady(map, () => {
      ensureResortLayers(map);
      map.getSource<GeoJSONSource>(RESORT_SOURCE)?.setData(geojson);
    });
  }, [resort, colorScheme, showLifts]);

  // --- 2c. Resort outline layer ---
  // The first outline of a ski area brings the map to it if it isn't
  // wholly on screen, so a picked resort always ends up in view. Later
  // rings of the same area (a size change retraces) leave the view alone.
  const fittedOutlineIdRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return whenStyleReady(map, () => {
      ensureOutlineLayers(map);
      map.getSource<GeoJSONSource>(OUTLINE_SOURCE)?.setData(outlineGeoJSON(outline));
      if (!outline || outline.length < 3 || outlineId === fittedOutlineIdRef.current) return;
      fittedOutlineIdRef.current = outlineId;
      const bounds = outline.reduce(
        (box, point) => box.extend(point),
        new maplibregl.LngLatBounds(outline[0], outline[0]),
      );
      const view = map.getBounds();
      if (view.contains(bounds.getSouthWest()) && view.contains(bounds.getNorthEast())) return;
      map.fitBounds(bounds, { padding: OUTLINE_FIT_PADDING_PX, maxZoom: OUTLINE_FIT_MAX_ZOOM, duration: 600 });
    });
  }, [outline, outlineId]);

  // --- 3. Drag-to-move: dragging the shape's interior ---
  useEffect(() => {
    const path = shapePathRef.current;
    const map = mapRef.current;
    if (!path || !map) return;

    let dragging = false;
    let lastClient = { x: 0, y: 0 };

    const onDown = (e: PointerEvent) => {
      const b = bboxRef.current;
      if (!b) return;
      dragging = true;
      lastClient = { x: e.clientX, y: e.clientY };
      path.setPointerCapture(e.pointerId);
      map.dragPan.disable();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const b = bboxRef.current;
      if (!b) return;
      const dx = e.clientX - lastClient.x;
      const dy = e.clientY - lastClient.y;
      const center = bboxCenter(b);
      const cPx = map.project(center);
      const newCenter = map.unproject([cPx.x + dx, cPx.y + dy]);
      lastClient = { x: e.clientX, y: e.clientY };
      onCenterRef.current([newCenter.lng, newCenter.lat]);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        path.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      map.dragPan.enable();
    };

    // Forward wheel inside the shape to the map canvas so scroll-zoom works.
    const canvas = map.getCanvas();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    path.addEventListener("pointerdown", onDown);
    path.addEventListener("pointermove", onMove);
    path.addEventListener("pointerup", onUp);
    path.addEventListener("pointercancel", onUp);
    path.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      path.removeEventListener("pointerdown", onDown);
      path.removeEventListener("pointermove", onMove);
      path.removeEventListener("pointerup", onUp);
      path.removeEventListener("pointercancel", onUp);
      path.removeEventListener("wheel", onWheel);
    };
  }, []);

  // --- 4. Corner-handle resize (rectangle) ---
  // The OPPOSITE corner stays anchored in geographic space. We:
  //   1. Read the anchor's current geographic position.
  //   2. Read the cursor's geographic position (the new dragged corner).
  //   3. Compute the new center = midpoint of those two.
  //   4. Un-rotate the diagonal vector (cursor − anchor) into the
  //      shape's local frame; that gives (±W_new, ±H_new) directly.
  useEffect(() => {
    const wireCorner = (
      el: SVGCircleElement | null,
      isNW: boolean, // true = dragging NW, anchored on SE
    ) => {
      const map = mapRef.current;
      if (!el || !map) return;
      let dragging = false;
      const onDown = (e: PointerEvent) => {
        dragging = true;
        el.setPointerCapture(e.pointerId);
        map.dragPan.disable();
        e.stopPropagation();
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const b = bboxRef.current;
        if (!b) return;
        const w = widthRef.current;
        const h = heightRef.current;
        const rot = rotationRef.current;
        const center = bboxCenter(b);
        const halfWIn = shapeAABBHalf(shapeRef.current, w, h, rot)[0];
        const mPerIn = bboxWidthMeters(b) / (halfWIn * 2);

        // Anchored corner in shape-local coords:
        //   NW drag → anchor is SE = (+W/2, -H/2)
        //   SE drag → anchor is NW = (-W/2, +H/2)
        const anchorLocal: [number, number] = isNW
          ? [+w / 2, -h / 2]
          : [-w / 2, +h / 2];
        const anchorGeo = localToGeo(center, anchorLocal[0], anchorLocal[1], rot, mPerIn);

        const [cx, cy] = cursorContainerPx(e, containerRef.current);
        const dragged = map.unproject([cx, cy]);
        const draggedGeo: LngLat = [dragged.lng, dragged.lat];

        // Diagonal vector dragged − anchor, un-rotated to local inches.
        // For NW drag: local diag = NW − SE = (-W, +H).
        // For SE drag: local diag = SE − NW = (+W, -H).
        const localDiag = geoToLocal(anchorGeo, draggedGeo, rot, mPerIn);
        const sign = isNW ? -1 : 1;
        const newW = Math.max(2, sign * localDiag[0]);
        const newH = Math.max(2, -sign * localDiag[1]);

        const midLng = (draggedGeo[0] + anchorGeo[0]) / 2;
        const midLat = (draggedGeo[1] + anchorGeo[1]) / 2;
        onResizeRef.current(newW, newH, [midLng, midLat]);
      };
      const onUp = (e: PointerEvent) => {
        dragging = false;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        map.dragPan.enable();
      };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      return () => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
    };

    const cleanupNW = wireCorner(nwHandleRef.current, true);
    const cleanupSE = wireCorner(seHandleRef.current, false);
    return () => {
      cleanupNW?.();
      cleanupSE?.();
    };
  }, []);

  // --- 5. Perimeter-handle resize (circle / hexagon) ---
  // The handle sits at the east point of the un-rotated shape. Dragging
  // changes the radius / half-width; we keep the shape centered.
  useEffect(() => {
    const el = perimHandleRef.current;
    const map = mapRef.current;
    if (!el || !map) return;
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      map.dragPan.disable();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const b = bboxRef.current;
      if (!b) return;
      const w = widthRef.current;
      const h = heightRef.current;
      const rot = rotationRef.current;
      const sh = shapeRef.current;
      const center = bboxCenter(b);
      const halfWIn = shapeAABBHalf(sh, w, h, rot)[0];
      const mPerIn = bboxWidthMeters(b) / (halfWIn * 2);
      const [cx, cy] = cursorContainerPx(e, containerRef.current);
      const drag = map.unproject([cx, cy]);
      const local = geoToLocal(center, [drag.lng, drag.lat], rot, mPerIn);
      // Half-diameter is |local.x| (the handle sits at +x of the un-
      // rotated shape — by convention we treat the magnitude as the
      // radius so dragging through center doesn't flip the sign).
      const newHalfWIn = Math.max(1, Math.abs(local[0]));
      const newDiameter = newHalfWIn * 2;
      if (sh === "circle") {
        onResizeRef.current(newDiameter, newDiameter);
      } else if (sh === "hexagon") {
        onResizeRef.current(newDiameter, (newDiameter * Math.sqrt(3)) / 2);
      }
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      map.dragPan.enable();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // --- 6. Rotation handle ---
  // Compute the angle from the shape's center to the cursor; that's the
  // new rotation. We measure with respect to the canonical "top
  // midpoint" direction (which is (0, -1) in shape local — straight up
  // in screen pixels at rotation 0).
  useEffect(() => {
    const el = rotHandleRef.current;
    const map = mapRef.current;
    if (!el || !map) return;
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      map.dragPan.disable();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const b = bboxRef.current;
      if (!b) return;
      const center = bboxCenter(b);
      const cPx = map.project(center);
      const [cx, cy] = cursorContainerPx(e, containerRef.current);
      const dx = cx - cPx.x;
      const dy = cy - cPx.y;
      // The handle at rotation = 0 sits ABOVE the shape on a north-up
      // map. Our rotation is positive-CCW in the (x, +z=north) math
      // frame, which is CCW when viewed from above. A CW drag on screen
      // (which the user perceives as a clockwise twist) should therefore
      // decrease rotation. atan2(-dx, -dy) returns the math-CCW angle
      // from "up": for cursor at (dx, dy) = (-1, 0) (west) → +π/2.
      const angleRad = Math.atan2(-dx, -dy);
      const angleDeg = (angleRad * 180) / Math.PI;
      onRotationRef.current(angleDeg);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      map.dragPan.enable();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
      {/* SVG overlay covers the whole map; child elements are positioned
          in absolute screen pixels. The SVG itself doesn't capture
          pointer events; only its interactive children do. */}
      <svg
        ref={svgRef}
        className="shape-overlay-svg"
        width="100%"
        height="100%"
      >
        <g ref={groupRef} style={frameHidden ? { display: "none" } : undefined}>
          <path
            ref={shapePathRef}
            className="shape-fill"
            aria-label="Move shape"
            role="button"
            tabIndex={0}
          />
          <line ref={rotLineRef} className="rotation-line" />
          <circle
            ref={nwHandleRef}
            className="resize-handle"
            r={7}
            aria-label="Resize from NW"
            role="button"
          />
          <circle
            ref={seHandleRef}
            className="resize-handle"
            r={7}
            aria-label="Resize from SE"
            role="button"
          />
          <circle
            ref={perimHandleRef}
            className="resize-handle"
            r={7}
            aria-label="Resize diameter"
            role="button"
          />
          <circle
            ref={rotHandleRef}
            className="rotation-handle"
            r={7}
            aria-label="Rotate shape"
            role="button"
          />
        </g>
      </svg>
    </div>
  );
}
