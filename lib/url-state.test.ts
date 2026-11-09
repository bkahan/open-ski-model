import { describe, expect, it } from "vitest";

import { decodeUrlState, encodeUrlState, type UrlState } from "./url-state";

const base: UrlState = {
  bbox: [-72.52, 44.91, -72.48, 44.95],
  shape: "rectangle",
  silhouette: false,
  layerCount: 0,
  rotation: 0,
  widthInches: 6,
  heightInches: 6,
  baseThicknessInches: 0.25,
  reliefInches: 1.25,
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

describe("model height url state", () => {
  it("round-trips the model height", () => {
    const params = encodeUrlState({ ...base, reliefInches: 1.75 });
    expect(params.get("rh")).toBe("1.75");
    expect(decodeUrlState(params).reliefInches).toBe(1.75);
  });

  it("round-trips the stacked finish and omits it when smooth", () => {
    expect(encodeUrlState(base).has("ln")).toBe(false);
    expect(decodeUrlState(encodeUrlState({ ...base, layerCount: 8 })).layerCount).toBe(8);
    for (const bad of ["abc", "0", "2", "17", "999999999", "4.5"]) {
      expect(decodeUrlState(new URLSearchParams(`ln=${bad}`)).layerCount).toBeUndefined();
    }
  });

  it("round-trips the resort outline", () => {
    expect(encodeUrlState(base).has("ol")).toBe(false);
    expect(decodeUrlState(encodeUrlState({ ...base, silhouette: true })).silhouette).toBe(true);
  });

  it("rejects a height that is not positive", () => {
    expect(decodeUrlState(new URLSearchParams("rh=0")).reliefInches).toBeUndefined();
    expect(decodeUrlState(new URLSearchParams("rh=abc")).reliefInches).toBeUndefined();
  });
});

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
