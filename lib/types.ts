// Shared type definitions for Open Ski Model.

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

/** Result of a Nominatim geocoding search. */
export interface SearchResult {
  placeId: number;
  displayName: string;
  /** [W, S, E, N] from Nominatim's boundingbox. */
  bbox: Bbox;
  center: LngLat;
  type?: string;
  category?: string;
}
