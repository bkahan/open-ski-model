// Higher-resolution elevation for US bboxes via the USGS 3DEP ImageServer.
//
// The "3DEP" service serves a global elevation mosaic; for US areas it
// resolves down to 10m (and 1m in many places). We use the `exportImage`
// REST endpoint to request a single Float32 GeoTIFF for the bbox at a
// requested grid size — no tile stitching needed, just one HTTPS GET.
//
// The geotiff package parses the response into a Float32Array. No keys,
// no signing.

import { fromArrayBuffer } from "geotiff";

import type { Bbox } from "@/lib/types";
import type { ElevationResponse } from "./types";

const EXPORT_URL =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";

// USGS 3DEP serves data well beyond the US (it's a global mosaic), but
// the *quality* upgrade over terrarium is concentrated in these regions.
// We use these boxes only to decide whether `source: "auto"` should pick
// USGS — outside these boxes, terrarium is the better default because the
// global blend is more consistent.
const US_REGIONS: Bbox[] = [
  [-125, 24, -66, 50],   // CONUS
  [-180, 50, -129, 72],  // Alaska
  [-161, 18, -154, 23],  // Hawaii
  [-68, 17, -65, 19],    // Puerto Rico
];

export function bboxLikelyInUS(b: Bbox): boolean {
  const [w, s, e, n] = b;
  // Bbox must be fully inside at least one region.
  return US_REGIONS.some(
    ([rw, rs, re, rn]) => w >= rw && e <= re && s >= rs && n <= rn,
  );
}

/**
 * Query for one square grid covering exactly `bbox`. Left to itself the
 * server widens the extent until its pixels are square in degrees, which
 * away from the equator returns more ground north to south than was asked
 * for (41% more at 45°N). Squeezed into the frame, that puts every summit
 * closer to the middle than the runs drawn over it.
 */
export function usgsExportParams(bbox: Bbox, gridSize: number): URLSearchParams {
  const [w, s, e, n] = bbox;
  return new URLSearchParams({
    bbox: `${w},${s},${e},${n}`,
    bboxSR: "4326",
    imageSR: "4326",
    size: `${gridSize},${gridSize}`,
    adjustAspectRatio: "false",
    format: "tiff",
    pixelType: "F32",
    f: "image",
    interpolation: "RSP_BilinearInterpolation",
    noDataInterpretation: "esriNoDataMatchAny",
  });
}

export async function buildHeightGridUSGS(
  bbox: Bbox,
  gridSize: number,
): Promise<ElevationResponse> {
  if (gridSize < 16 || gridSize > 512) {
    throw new Error(`gridSize must be 16..512, got ${gridSize}`);
  }
  const params = usgsExportParams(bbox, gridSize);

  const res = await fetch(`${EXPORT_URL}?${params}`, {
    cache: "force-cache",
    next: { revalidate: 60 * 60 * 24 * 7 }, // 7 days
  });
  if (!res.ok) {
    throw new Error(`USGS 3DEP HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  // ArcGIS sometimes returns JSON errors with 200 OK; sniff the magic
  // bytes — TIFF starts with "II"/"MM".
  const head = new Uint8Array(buf, 0, 4);
  const isTiff =
    (head[0] === 0x49 && head[1] === 0x49) ||
    (head[0] === 0x4d && head[1] === 0x4d);
  if (!isTiff) {
    const text = new TextDecoder().decode(buf.slice(0, 200));
    throw new Error(`USGS 3DEP returned non-TIFF: ${text.slice(0, 120)}`);
  }

  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const band = rasters[0];
  if (!band || typeof band === "number") {
    throw new Error("USGS 3DEP: no raster band");
  }

  // Most USGS responses come back as Float32Array; coerce to number[] to
  // match our JSON-serializable response shape.
  const arr = band as Float32Array | Int16Array | Uint16Array;
  const heights = new Array<number>(arr.length);
  let min = Infinity;
  let max = -Infinity;
  // The ImageServer returns its no-data sentinel as a very small negative
  // float (-3.4e38). Filter those out.
  const NO_DATA_SENTINEL = -1e30;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < NO_DATA_SENTINEL) {
      heights[i] = NaN;
      continue;
    }
    heights[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("USGS 3DEP: bbox returned all no-data");
  }

  // Replace NaNs with min so downstream mesh math stays finite.
  for (let i = 0; i < heights.length; i++) {
    if (Number.isNaN(heights[i])) heights[i] = min;
  }

  return {
    heights,
    width: image.getWidth(),
    height: image.getHeight(),
    min,
    max,
    source: "usgs",
    zoom: 0,
  };
}
