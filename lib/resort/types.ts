import type { Bbox, LngLat } from "@/lib/types";

/** OSM `piste:difficulty` values, plus `unknown` for untagged runs. */
export type RunDifficulty =
  | "novice"
  | "easy"
  | "intermediate"
  | "advanced"
  | "expert"
  | "freeride"
  | "extreme"
  | "unknown";

export type LiftType =
  | "chair_lift"
  | "gondola"
  | "cable_car"
  | "mixed_lift"
  | "drag_lift"
  | "t-bar"
  | "j-bar"
  | "platter"
  | "rope_tow"
  | "magic_carpet"
  | "other";

export interface SkiRun {
  /** OSM way id. */
  id: number;
  name?: string;
  difficulty: RunDifficulty;
  /** Polyline in [lng, lat]. Closed when the way is tagged as an area. */
  coords: LngLat[];
  /** True when OSM maps the run as a polygon (`area:piste` / `area=yes`). */
  isArea: boolean;
}

export interface SkiLift {
  /** OSM way id. */
  id: number;
  name?: string;
  type: LiftType;
  coords: LngLat[];
}

export interface ResortRequest {
  bbox: Bbox;
}

export interface ResortData {
  runs: SkiRun[];
  lifts: SkiLift[];
  /** The bbox the data was fetched for. */
  bbox: Bbox;
  /** Extent of all run + lift geometry, or null when nothing was found. */
  extent: Bbox | null;
}
