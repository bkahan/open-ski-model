// Shared type definitions for Open Ski Model.

import type { Shape } from "@/lib/shape";

/** [west, south, east, north] in WGS84 degrees. */
export type Bbox = [number, number, number, number];

/** A geographic point [lng, lat] in WGS84 degrees. */
export type LngLat = [number, number];

/**
 * Everything needed to define a model: the geographic bbox plus the physical
 * print dimensions. Phase 2 takes one of these and returns a 3D mesh / STL.
 */
export interface ModelSpec {
  /** Geographic bounding box [W, S, E, N]. */
  bbox: Bbox;
  /** Shape inscribed in the bbox — controls the model footprint. */
  shape: Shape;
  /** Physical print width in inches. */
  widthInches: number;
  /** Physical print height in inches. */
  heightInches: number;
  /** Thickness of the flat base under the terrain, in inches. */
  baseThicknessInches: number;
  /** Multiplier on real elevation. 1 = true scale (usually too flat). */
  verticalExaggeration: number;
  /** Optional friendly label, e.g. "Jay Peak". */
  label?: string;
}

/** A search hit: a ski area from the OpenSkiData index, or a Nominatim place. */
export interface SearchResult {
  kind: "resort" | "place";
  id: string;
  /** Short name shown as the title and used as the model label. */
  name: string;
  /** Secondary line: locality for resorts, full display name for places. */
  detail: string;
  /** [W, S, E, N]. For resorts, the axis-aligned bounds of the natural viewport. */
  bbox: Bbox;
  center: LngLat;
  /** Resorts only: the viewport's rotation, degrees clockwise from north. */
  bearing?: number;
  /** Resorts only: which trail-marking convention the data uses. */
  convention?: "north_america" | "europe" | "japan";
}
