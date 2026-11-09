// Text as geometry: glyph outlines from opentype.js, extruded by
// Manifold. Fonts are loaded once per session.

import type { Manifold, ManifoldToplevel } from "manifold-3d";
import * as opentype from "opentype.js";

import { extrudeContours } from "./manifold";

let fontPromise: Promise<opentype.Font> | null = null;

export function loadFont(url = "/fonts/Roboto-Regular.ttf"): Promise<opentype.Font> {
  if (!fontPromise) {
    fontPromise = fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`);
        return opentype.parse(await res.arrayBuffer());
      })
      .catch((err: unknown) => {
        fontPromise = null;
        throw err;
      });
  }
  return fontPromise;
}

export type Contour = Array<[number, number]>;

/**
 * Convert an opentype path into closed contours with y UP and the
 * baseline at 0. opentype paths are screen-oriented (y grows downward),
 * so y is negated here. Curves are flattened with a fixed subdivision;
 * glyphs are small enough on these models that 6 steps is invisible.
 */
export function pathToContours(path: opentype.Path, curveSteps = 6): Contour[] {
  const contours: Contour[] = [];
  let current: Contour = [];
  let last: [number, number] = [0, 0];
  const flush = () => {
    if (current.length >= 3) contours.push(current);
    current = [];
  };
  const push = (x: number, y: number) => current.push([x, -y]);
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        flush();
        push(cmd.x, cmd.y);
        last = [cmd.x, cmd.y];
        break;
      case "L":
        push(cmd.x, cmd.y);
        last = [cmd.x, cmd.y];
        break;
      case "Q":
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps;
          const mt = 1 - t;
          push(
            mt * mt * last[0] + 2 * mt * t * cmd.x1 + t * t * cmd.x,
            mt * mt * last[1] + 2 * mt * t * cmd.y1 + t * t * cmd.y,
          );
        }
        last = [cmd.x, cmd.y];
        break;
      case "C":
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps;
          const mt = 1 - t;
          push(
            mt ** 3 * last[0] + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t ** 3 * cmd.x,
            mt ** 3 * last[1] + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t ** 3 * cmd.y,
          );
        }
        last = [cmd.x, cmd.y];
        break;
      case "Z":
        flush();
        break;
    }
  }
  flush();
  return contours;
}

/**
 * The font size (em) that gives capitals the requested height. Falls
 * back to a typical 0.7 em when the font doesn't declare one.
 */
export function fontSizeForCapHeight(font: opentype.Font, capHeight: number): number {
  const declared = (font.tables.os2 as { sCapHeight?: number } | undefined)?.sCapHeight;
  const ratio = declared && declared > 0 ? declared / font.unitsPerEm : 0.7;
  return capHeight / ratio;
}

/** Outlines for a whole string, left edge at x = 0. */
export function textContours(font: opentype.Font, text: string, size: number): Contour[] {
  return pathToContours(font.getPath(text, 0, 0, size));
}

export interface PlacedGlyph {
  /** Outlines in text space (baseline y = 0), already offset to the glyph's x. */
  contours: Contour[];
  /** Horizontal center of the glyph's advance box. */
  centerX: number;
  advance: number;
}

/** Each visible glyph with its position along the baseline (kerning applied). */
export function layoutGlyphs(font: opentype.Font, text: string, size: number): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  font.forEachGlyph(text, 0, 0, size, { kerning: true }, (glyph, x, y) => {
    const advance = ((glyph.advanceWidth ?? 0) * size) / font.unitsPerEm;
    const contours = pathToContours(glyph.getPath(x, y, size));
    if (contours.length === 0) return;
    out.push({ contours, centerX: x + advance / 2, advance });
  });
  return out;
}

export function measureTextWidth(font: opentype.Font, text: string, size: number): number {
  return font.getAdvanceWidth(text, size, { kerning: true });
}

/**
 * Solid text in the XY plane, extruded along +Z from 0 to `depth`.
 * Returns null for a string with no visible glyphs.
 */
export function buildTextSolid(
  m: ManifoldToplevel,
  font: opentype.Font,
  text: string,
  size: number,
  depth: number,
): Manifold | null {
  const contours = textContours(font, text, size);
  if (contours.length === 0) return null;
  return extrudeContours(m, contours, depth);
}
