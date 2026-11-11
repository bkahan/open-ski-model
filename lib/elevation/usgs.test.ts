import { describe, expect, it } from "vitest";

import type { Bbox } from "@/lib/types";

import { bboxLikelyInUS, usgsExportParams } from "./usgs";

const jayPeak: Bbox = [-72.53499, 44.9163, -72.49843, 44.94219];

describe("usgsExportParams", () => {
  it("asks for the frame's own extent, not one widened to square pixels", () => {
    const params = usgsExportParams(jayPeak, 256);
    expect(params.get("bbox")).toBe("-72.53499,44.9163,-72.49843,44.94219");
    expect(params.get("size")).toBe("256,256");
    // Without this the service returned 44.910965 to 44.947525 for this
    // frame: 41% more ground north to south than the grid is taken to cover.
    expect(params.get("adjustAspectRatio")).toBe("false");
  });

  it("keeps the grid in degrees, matching how the mesh lays it out", () => {
    const params = usgsExportParams(jayPeak, 128);
    expect(params.get("bboxSR")).toBe("4326");
    expect(params.get("imageSR")).toBe("4326");
  });
});

describe("bboxLikelyInUS", () => {
  it("takes a frame only when all of it is inside a US region", () => {
    expect(bboxLikelyInUS(jayPeak)).toBe(true);
    expect(bboxLikelyInUS([-123.2, 49.9, -122.8, 50.2])).toBe(false);
  });
});
