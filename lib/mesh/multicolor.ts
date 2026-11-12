// Turns the built solids into one body per filament. One AMS gives four
// filaments: white terrain and three trail colors, with lifts and text in
// black. A second AMS keeps every color separate and adds forest green
// to the terrain below the treeline.

import type { Manifold, ManifoldToplevel } from "manifold-3d";

import type { BuiltModel } from "./engrave";
import type { ThreeMfFilament, ThreeMfPart } from "./three-mf";

const FILAMENT_COLORS: Record<string, ThreeMfFilament> = {
  white: { name: "White", hex: "#FFFFFF" },
  forest: { name: "Forest green", hex: "#2F5D3A" },
  green: { name: "Green", hex: "#1F9D55" },
  blue: { name: "Blue", hex: "#2563EB" },
  red: { name: "Red", hex: "#DC2626" },
  orange: { name: "Orange", hex: "#F97316" },
  gray: { name: "Gray", hex: "#9CA3AF" },
  black: { name: "Black", hex: "#111827" },
};

const FILAMENT_ORDER = Object.keys(FILAMENT_COLORS);

/** Colors merged when only one AMS is loaded, and for which trail systems. */
const ONE_AMS_MERGES: Record<string, string> = { gray: "black", orange: "black", lift: "black" };
const SECOND_AMS_MERGES: Record<string, string> = { lift: "gray" };

/** Treeline as a share of the relief: below it, the second AMS prints forest. */
const TREELINE_FRACTION = 0.6;

/** Height of the treeline on terrain whose surface runs from `lowY` up to `summitY`. */
export function treelineFor(lowY: number, summitY: number): number {
  return lowY + TREELINE_FRACTION * (summitY - lowY);
}

/** On one AMS only three trail colors fit, so green goes where the scheme has four. */
function oneAmsColor(key: string, usesRed: boolean): string {
  const merged = ONE_AMS_MERGES[key] ?? key;
  return usesRed && merged === "green" ? "blue" : merged;
}

export interface ColorBodies {
  parts: ThreeMfPart[];
  filaments: ThreeMfFilament[];
}

/**
 * `treelineY` is in the terrain's own space, before it is lifted onto the
 * plinth. Null leaves the terrain all white, as does a single AMS.
 */
export function buildColorBodies(
  m: ManifoldToplevel,
  built: BuiltModel,
  treelineY: number | null,
  secondAms: boolean,
): ColorBodies {
  const owned: Manifold[] = [];
  const own = (s: Manifold) => {
    owned.push(s);
    return s;
  };

  try {
    const pieces = new Map<string, Manifold[]>();
    const add = (color: string, solid: Manifold) => {
      pieces.set(color, [...(pieces.get(color) ?? []), solid]);
    };

    const lifted = own(built.terrain.translate([0, built.terrainLift, 0]));
    if (secondAms && treelineY !== null) {
      const [upper, lower] = lifted.splitByPlane([0, 1, 0], treelineY + built.terrainLift);
      add("white", own(upper));
      // The terrain's seat overlaps the plinth, which stays white.
      add("forest", built.plinth ? own(m.Manifold.difference(own(lower), built.plinth)) : own(lower));
    } else {
      add("white", lifted);
    }
    if (built.plinth) add("white", built.plinth);

    const usesRed = built.colorInlays.some((inlay) => inlay.key === "red");
    const colorFor = (key: string) =>
      secondAms ? (SECOND_AMS_MERGES[key] ?? key) : oneAmsColor(key, usesRed);
    for (const inlay of built.colorInlays) {
      add(colorFor(inlay.key), own(inlay.solid.translate([0, built.terrainLift, 0])));
    }
    for (const glyph of built.inlays) add("black", glyph);

    // A color can come out empty, such as forest when no step is below treeline.
    const bodies = FILAMENT_ORDER.filter((color) => pieces.has(color))
      .map((color) => ({ color, solid: own(m.Manifold.union(pieces.get(color)!)) }))
      .filter(({ solid }) => !solid.isEmpty());
    const parts = bodies.map(({ color, solid }, i): ThreeMfPart => {
      const mesh = solid.getMesh();
      return {
        name: FILAMENT_COLORS[color].name,
        filament: i + 1,
        positions: mesh.vertProperties,
        positionStride: mesh.numProp,
        triangles: mesh.triVerts,
      };
    });
    return { parts, filaments: bodies.map(({ color }) => FILAMENT_COLORS[color]) };
  } finally {
    for (const s of owned) s.delete();
  }
}
