// Encode / decode the model spec into URL search params so users can
// share a specific view. Format is compact + human-readable enough that
// you can hand-edit a URL if you really want to.
//
// Examples:
//   /?b=-72.520,44.910,-72.480,44.950&s=6x6&t=0.25&rh=1.25&label=Jay%20Peak
//   /?b=-122.97,50.10,-122.91,50.14&s=8x6&t=0.25&rh=2&label=Whistler

import { isColorSchemeSetting, type ColorSchemeSetting } from "@/lib/resort/colors";
import { DEFAULT_RESORT_SETTINGS } from "@/lib/resort/settings";
import type { Shape } from "@/lib/shape";
import type { Bbox } from "@/lib/types";

export interface UrlState {
  bbox: Bbox;
  shape: Shape;
  silhouette: boolean;
  areaId: string | null;
  rotation: number;
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  reliefInches: number;
  aspectLocked: boolean;
  gridSize: number;
  engraveLabel: boolean;
  engraveBrand: boolean;
  showRuns: boolean;
  showLifts: boolean;
  minRunWidthMm: number;
  colorScheme: ColorSchemeSetting;
  label?: string;
  /** Second line of the name plate. */
  place?: string;
}

const SHAPES: Shape[] = ["rectangle", "circle", "hexagon"];

export function encodeUrlState(s: UrlState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("b", s.bbox.map((v) => v.toFixed(5)).join(","));
  params.set("s", `${trim(s.widthInches)}x${trim(s.heightInches)}`);
  params.set("sh", s.shape);
  if (s.silhouette) params.set("ol", "1");
  if (s.areaId) params.set("ra", s.areaId);
  if (s.rotation !== 0) params.set("r", trim(s.rotation));
  if (s.aspectLocked) params.set("lk", "1");
  if (s.gridSize !== 256) params.set("g", String(Math.round(s.gridSize)));
  if (s.engraveLabel) params.set("el", "1");
  // Default-on toggle: persist "0" only when disabled.
  if (!s.engraveBrand) params.set("eb", "0");
  if (!s.showRuns) params.set("runs", "0");
  if (!s.showLifts) params.set("lf", "0");
  if (s.minRunWidthMm !== DEFAULT_RESORT_SETTINGS.minRunWidthMm) {
    params.set("mw", trim(s.minRunWidthMm));
  }
  if (s.colorScheme !== "auto") params.set("cs", s.colorScheme);
  params.set("t", trim(s.baseThicknessInches));
  params.set("rh", trim(s.reliefInches));
  if (s.label) params.set("label", s.label);
  if (s.place) params.set("place", s.place);
  return params;
}

export function decodeUrlState(params: URLSearchParams): Partial<UrlState> {
  const out: Partial<UrlState> = {};

  const b = params.get("b");
  if (b) {
    const parts = b.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      out.bbox = parts as Bbox;
    }
  }
  const s = params.get("s");
  if (s) {
    const [w, h] = s.split("x").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      out.widthInches = w;
      out.heightInches = h;
    }
  }
  const sh = params.get("sh");
  if (sh && (SHAPES as string[]).includes(sh)) {
    out.shape = sh as Shape;
  }
  if (params.get("ol") === "1") out.silhouette = true;
  const ra = params.get("ra");
  if (ra) out.areaId = ra;
  const r = params.get("r");
  if (r && Number.isFinite(Number(r))) out.rotation = Number(r);
  if (params.get("lk") === "1") out.aspectLocked = true;
  const g = params.get("g");
  if (g && Number.isFinite(Number(g))) out.gridSize = Math.round(Number(g));
  const el = params.get("el");
  if (el === "1") out.engraveLabel = true;
  const eb = params.get("eb");
  if (eb === "0") out.engraveBrand = false;
  if (params.get("runs") === "0") out.showRuns = false;
  if (params.get("lf") === "0") out.showLifts = false;
  const mw = params.get("mw");
  if (mw && Number.isFinite(Number(mw)) && Number(mw) > 0) out.minRunWidthMm = Number(mw);
  const cs = params.get("cs");
  if (cs && isColorSchemeSetting(cs)) out.colorScheme = cs;
  const t = params.get("t");
  if (t && Number.isFinite(Number(t))) out.baseThicknessInches = Number(t);
  const rh = params.get("rh");
  if (rh && Number.isFinite(Number(rh)) && Number(rh) > 0) out.reliefInches = Number(rh);
  const label = params.get("label");
  if (label) out.label = label;
  const place = params.get("place");
  if (place) out.place = place;

  return out;
}

function trim(n: number): string {
  // Drop trailing zeros while keeping precision.
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Replace the URL with the encoded state without adding a history entry.
 * Safe to call frequently — uses history.replaceState. No-ops on SSR.
 */
export function syncUrl(state: UrlState) {
  if (typeof window === "undefined") return;
  const params = encodeUrlState(state);
  const url = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", url);
}
