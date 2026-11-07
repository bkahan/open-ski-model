import { describe, expect, it } from "vitest";

import { MAX_BBOX_DEG, parseResortRequest, snapBboxOutward } from "./request";

describe("parseResortRequest", () => {
  it("accepts a valid bbox", () => {
    expect(parseResortRequest({ bbox: [-72.55, 44.9, -72.45, 44.96] })).toEqual([
      -72.55, 44.9, -72.45, 44.96,
    ]);
  });

  it.each([
    [null, "body must be an object"],
    [{}, "bbox must be [w,s,e,n]"],
    [{ bbox: [1, 2, 3] }, "bbox must be [w,s,e,n]"],
    [{ bbox: [1, 2, 3, "4"] }, "bbox values must be finite numbers"],
    [{ bbox: [1, 2, 3, NaN] }, "bbox values must be finite numbers"],
    [{ bbox: [-181, 0, 1, 1] }, "bbox out of range"],
    [{ bbox: [1, 1, 0, 2] }, "bbox W/S must be less than E/N"],
    [{ bbox: [0, 0, MAX_BBOX_DEG + 0.1, 0.1] }, `bbox too large (max ${MAX_BBOX_DEG}° per side)`],
  ])("rejects %j", (input, message) => {
    expect(parseResortRequest(input)).toBe(message);
  });
});

describe("snapBboxOutward", () => {
  it("expands to the enclosing grid cells", () => {
    expect(snapBboxOutward([-72.5349, 44.9101, -72.4651, 44.9499], 0.01)).toEqual([
      -72.54, 44.91, -72.46, 44.95,
    ]);
  });

  it("leaves aligned corners alone", () => {
    expect(snapBboxOutward([-72.54, 44.91, -72.46, 44.95], 0.01)).toEqual([
      -72.54, 44.91, -72.46, 44.95,
    ]);
  });
});
