import { describe, expect, it } from "vitest";

import { decodeUrlState, encodeUrlState, type UrlState } from "./url-state";

const base: UrlState = {
  bbox: [-72.52, 44.91, -72.48, 44.95],
  shape: "rectangle",
  rotation: 0,
  widthInches: 6,
  heightInches: 6,
  baseThicknessInches: 0.25,
  verticalExaggeration: 2,
  aspectLocked: true,
  gridSize: 256,
  engraveLabel: false,
  engraveBrand: true,
  showRuns: true,
  showLifts: true,
  minRunWidthMm: 1.2,
  colorScheme: "auto",
  label: "Jay Peak",
};

describe("resort url state", () => {
  it("omits resort params at their defaults", () => {
    const params = encodeUrlState(base);
    expect(params.has("runs")).toBe(false);
    expect(params.has("lf")).toBe(false);
    expect(params.has("mw")).toBe(false);
    expect(params.has("cs")).toBe(false);
  });

  it("round-trips non-default resort settings", () => {
    const params = encodeUrlState({
      ...base,
      showRuns: false,
      showLifts: false,
      minRunWidthMm: 1.6,
      colorScheme: "eu",
    });
    expect(params.get("runs")).toBe("0");
    expect(params.get("lf")).toBe("0");
    expect(params.get("mw")).toBe("1.6");
    expect(params.get("cs")).toBe("eu");

    const decoded = decodeUrlState(params);
    expect(decoded.showRuns).toBe(false);
    expect(decoded.showLifts).toBe(false);
    expect(decoded.minRunWidthMm).toBe(1.6);
    expect(decoded.colorScheme).toBe("eu");
  });

  it("ignores junk values", () => {
    const decoded = decodeUrlState(new URLSearchParams("mw=abc&cs=mars&mw=-1"));
    expect(decoded.minRunWidthMm).toBeUndefined();
    expect(decoded.colorScheme).toBeUndefined();
  });
});
