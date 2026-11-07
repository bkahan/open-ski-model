import type { Bbox, LngLat } from "@/lib/types";

/** OpenSkiData difficulty values, plus `unknown` for untagged runs. */
export type RunDifficulty =
  | "novice"
  | "easy"
  | "intermediate"
  | "advanced"
  | "expert"
  | "freeride"
  | "extreme"
  | "unknown";

/** Which trail-marking convention a run's difficulty was assigned under. */
export type RunConvention = "north_america" | "europe" | "japan";

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
  | "funicular"
  | "railway"
  | "other";

export interface SkiRun {
  /** OpenSkiData id; multi-part runs get a `:n` suffix per part. */
  id: string;
  name?: string;
  difficulty: RunDifficulty;
  convention: RunConvention;
  /** Polyline in [lng, lat]; the outer ring when `isArea`. */
  coords: LngLat[];
  /** True when the run is mapped as a polygon. */
  isArea: boolean;
}

export interface SkiLift {
  /** OpenSkiData id; multi-part lifts get a `:n` suffix per part. */
  id: string;
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
  /** The bbox the data covers. */
  bbox: Bbox;
  /** Extent of all run + lift geometry, or null when nothing was found. */
  extent: Bbox | null;
  /** Convention used by most runs here, or null when there are none. */
  convention: RunConvention | null;
}

/** One entry of the ski-area search index. */
export interface SkiAreaHit {
  id: string;
  name: string;
  /** "Locality, Region, Country" when known. */
  location: string | null;
  countryCode: string | null;
  convention: RunConvention;
  center: LngLat;
  /** Rotation of the natural viewport, degrees clockwise from north. */
  bearing: number;
  /** Size of the natural viewport along its rotated axes, in meters. */
  widthMeters: number;
  heightMeters: number;
  runCount: number;
}
