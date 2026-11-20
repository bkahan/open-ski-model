import type { Bbox, LngLat } from "@/lib/types";

export interface HikeTrail {
  /** OpenStreetMap way, as "w<id>". */
  id: string;
  name?: string;
  /** Tagged informal=yes: a path people walk that no one maintains. */
  informal: boolean;
  /** Polyline in [lng, lat]. */
  coords: LngLat[];
}

export type HikePoiKind = "peak" | "hut" | "trailhead";

export interface HikePoi {
  /** OpenStreetMap element, as "n<id>", "w<id>" or "r<id>". */
  id: string;
  kind: HikePoiKind;
  name?: string;
  /** Peaks only, when OpenStreetMap has one. */
  elevationMeters?: number;
  at: LngLat;
}

export interface HikeWater {
  /** OpenStreetMap element; a multi-part lake gets a `:n` suffix per part. */
  id: string;
  name?: string;
  outer: LngLat[];
  holes: LngLat[][];
}

export interface HikeData {
  trails: HikeTrail[];
  pois: HikePoi[];
  water: HikeWater[];
  /** The bbox the data covers. */
  bbox: Bbox;
  /** Extent of all trail geometry, or null when nothing was found. */
  extent: Bbox | null;
}

export type HikePlaceKind = "range" | "peak" | "trail" | "hut";

/** One entry of the hiking search index. */
export interface HikePlaceHit {
  id: string;
  name: string;
  kind: HikePlaceKind;
  /** The extract the place came from: a US state code. */
  region: string | null;
  center: LngLat;
  /** Trails, and ranges drawn as more than a point. */
  bbox: Bbox | null;
  elevationMeters?: number;
  lengthKm?: number;
}
