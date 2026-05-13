import type { Bbox } from "@/lib/types";

export type ElevationSource = "auto" | "terrarium" | "usgs";

export interface ElevationRequest {
  bbox: Bbox;
  /** Number of cells per side of the output square grid. */
  gridSize: number;
  /** Which dataset to use. "auto" picks USGS for US bboxes, otherwise terrarium. */
  source?: ElevationSource;
}

export interface ElevationResponse {
  /**
   * Row-major flat array of elevation values in meters. Length = width * height.
   * NaN entries indicate no-data pixels (rare; near poles or coverage gaps).
   */
  heights: number[];
  width: number;
  height: number;
  min: number;
  max: number;
  /** Which dataset actually served the data. */
  source: "terrarium" | "usgs";
  /** For terrarium: Web Mercator zoom level used. For USGS: 0. */
  zoom: number;
}
