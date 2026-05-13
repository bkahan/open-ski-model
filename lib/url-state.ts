// Encode / decode the model spec into URL search params so users can
// share a specific view. Format is compact + human-readable enough that
// you can hand-edit a URL if you really want to.
//
// Examples:
//   /?b=-72.520,44.910,-72.480,44.950&s=6x6&t=0.25&v=2&label=Jay%20Peak
//   /?b=-122.97,50.10,-122.91,50.14&s=8x6&t=0.25&v=2.5&label=Whistler

import type { Shape } from "@/lib/shape";
import type { Bbox } from "@/lib/types";

export interface UrlState {
  bbox: Bbox;
  shape: Shape;
  rotation: number;
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  verticalExaggeration: number;
  aspectLocked: boolean;
  label?: string;
}

const SHAPES: Shape[] = ["rectangle", "circle", "hexagon"];

export function encodeUrlState(s: UrlState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("b", s.bbox.map((v) => v.toFixed(5)).join(","));
  params.set("s", `${trim(s.widthInches)}x${trim(s.heightInches)}`);
  params.set("sh", s.shape);
  if (s.rotation !== 0) params.set("r", trim(s.rotation));
  if (s.aspectLocked) params.set("lk", "1");
  params.set("t", trim(s.baseThicknessInches));
  params.set("v", trim(s.verticalExaggeration));
  if (s.label) params.set("label", s.label);
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
  const r = params.get("r");
  if (r && Number.isFinite(Number(r))) out.rotation = Number(r);
  if (params.get("lk") === "1") out.aspectLocked = true;
  const t = params.get("t");
  if (t && Number.isFinite(Number(t))) out.baseThicknessInches = Number(t);
  const v = params.get("v");
  if (v && Number.isFinite(Number(v))) out.verticalExaggeration = Number(v);
  const label = params.get("label");
  if (label) out.label = label;

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
