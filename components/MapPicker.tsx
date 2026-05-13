"use client";

// Interactive 2D map with a draggable / resizable bounding box.
//
// Mental model:
//   - The map is a window onto Earth. We render it with MapLibre GL using
//     plain OpenStreetMap raster tiles (no token required).
//   - The bbox lives in geographic coordinates (lng/lat). On every map
//     "move" event we re-project its corners to pixels and reposition the
//     overlay <div> + handles on top of the canvas.
//   - User interactions update the bbox in geographic coordinates, then we
//     re-render. The map itself is "the truth"; the overlay is just a view.
//
// Phase 1 keeps the geometry simple: an axis-aligned rectangle (in lng/lat),
// width-driven, with the height derived from a parent-supplied aspect ratio.
// Phase 2 will hand the bbox to the elevation API and Babylon viewer.

// maplibre-gl.css is imported from app/layout.tsx — keeping it there
// guarantees it's bundled as a static stylesheet.

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import {
  bboxCenter,
  bboxFromCenter,
  bboxWidthMeters,
} from "@/lib/bbox";
import type { Bbox, LngLat } from "@/lib/types";

interface Props {
  bbox: Bbox | null;
  /** width / height. Locks the bbox aspect to the print aspect. */
  aspect: number;
  onBboxChange: (next: Bbox) => void;
  /** When set, the map fly-tos this center. */
  flyTo?: LngLat | null;
}

// Basemap: OpenTopoMap raster tiles — free, no API key, CC-BY-SA, and
// (the bonus) actually a topographic style with contour lines baked in,
// which is exactly what you want when framing a ski mountain. Three
// mirrors for redundancy. If a MapTiler key is set we use their outdoor
// style instead.
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

export default function MapPicker({
  bbox,
  aspect,
  onBboxChange,
  flyTo,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const handleRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // We keep the latest bbox in a ref so mouse-move handlers always see fresh
  // state without re-binding listeners every render.
  const bboxRef = useRef<Bbox | null>(bbox);
  bboxRef.current = bbox;
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;
  const onChangeRef = useRef(onBboxChange);
  onChangeRef.current = onBboxChange;

  // --- 1. Initialize the map once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAPTILER_STYLE_URL ?? OPENTOPO_STYLE,
      center: [-72.5, 44.93], // Jay Peak-ish: a friendly default
      zoom: 11,
      // In MapLibre v4 the constructor option is a boolean. To get the
      // compact-attribution look we disable the default and add our own.
      attributionControl: false,
    });
    // Surface tile / style errors in the console so you can tell when the
    // basemap host is unreachable.
    map.on("error", (e) => {
      const err = (e as { error?: { message?: string } }).error;
      // eslint-disable-next-line no-console
      console.warn("[map error]", err?.message ?? e);
    });
    // Force a resize shortly after mount in case the container hadn't
    // settled to its final size when MapLibre measured it.
    setTimeout(() => map.resize(), 100);
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
      map.off("move", repaint);
      map.off("resize", repaint);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 2. Repaint overlay whenever bbox or aspect changes ---
  const paintOverlay = useCallback(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    const b = bboxRef.current;
    if (!map || !overlay || !b) return;

    const nw = map.project([b[0], b[3]]);
    const se = map.project([b[2], b[1]]);
    const left = Math.min(nw.x, se.x);
    const top = Math.min(nw.y, se.y);
    const width = Math.abs(se.x - nw.x);
    const height = Math.abs(se.y - nw.y);

    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;

    const resizeH = handleRefs.current.resize;
    if (resizeH) {
      resizeH.style.left = `${left + width - 7}px`;
      resizeH.style.top = `${top + height - 7}px`;
    }
  }, []);

  useEffect(() => {
    paintOverlay();
  }, [bbox, aspect, paintOverlay]);

  // --- 3. Fly to new search result ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo({ center: flyTo, zoom: Math.max(map.getZoom(), 12), duration: 800 });
  }, [flyTo]);

  // --- 4. Drag-to-move (anywhere inside the bbox overlay) ---
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;

    let dragging = false;
    let startPx = { x: 0, y: 0 };

    const onDown = (e: PointerEvent) => {
      const b = bboxRef.current;
      if (!b) return;
      dragging = true;
      startPx = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
      map.dragPan.disable();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const b = bboxRef.current;
      if (!b) return;
      const dx = e.clientX - startPx.x;
      const dy = e.clientY - startPx.y;
      const center = bboxCenter(b);
      const centerPx = map.project(center);
      const newPx = { x: centerPx.x + dx, y: centerPx.y + dy };
      const newCenter = map.unproject([newPx.x, newPx.y]);
      startPx = { x: e.clientX, y: e.clientY };
      const w = bboxWidthMeters(b);
      onChangeRef.current(
        bboxFromCenter([newCenter.lng, newCenter.lat], w, aspectRef.current),
      );
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        overlay.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      map.dragPan.enable();
    };

    // The overlay sits above the MapLibre canvas with pointer-events: auto,
    // which would otherwise swallow scroll-zoom. Re-dispatch wheel events to
    // the canvas so the user can zoom while their cursor is inside the bbox.
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

    overlay.addEventListener("pointerdown", onDown);
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", onUp);
    overlay.addEventListener("pointercancel", onUp);
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      overlay.removeEventListener("pointerdown", onDown);
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerup", onUp);
      overlay.removeEventListener("pointercancel", onUp);
      overlay.removeEventListener("wheel", onWheel);
    };
  }, []);

  // --- 5. Drag-to-resize (SE corner) ---
  useEffect(() => {
    const map = mapRef.current;
    const handle = handleRefs.current.resize;
    if (!map || !handle) return;

    let dragging = false;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      map.dragPan.disable();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const b = bboxRef.current;
      if (!b) return;
      const center = bboxCenter(b);
      const centerPx = map.project(center);
      const dxPx = e.clientX - centerPx.x;
      // Convert horizontal half-width in px to meters: project a point
      // dxPx to the right of center and measure ground distance.
      const rightLngLat = map.unproject([centerPx.x + Math.abs(dxPx), centerPx.y]);
      const halfWidthMeters = haversine(center, [rightLngLat.lng, rightLngLat.lat]);
      const widthMeters = Math.max(200, halfWidthMeters * 2);
      onChangeRef.current(
        bboxFromCenter(center, widthMeters, aspectRef.current),
      );
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      map.dragPan.enable();
    };

    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    return () => {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
      <div
        ref={overlayRef}
        className="bbox-overlay"
        aria-label="Move bounding box"
        role="button"
        tabIndex={0}
      />
      <div
        ref={(el) => {
          handleRefs.current.resize = el;
        }}
        className="bbox-handle"
        aria-label="Resize bounding box"
        role="button"
        tabIndex={0}
      />
    </div>
  );
}

// Great-circle distance in meters. We use this once per resize tick — fine
// for an interactive UI, but if you ever need it in a hot loop, switch to
// the small-angle approximation in lib/bbox.ts.
function haversine(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
