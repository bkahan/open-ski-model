import { describe, expect, it } from "vitest";

import { decodeUrlState, encodeUrlState, type UrlState } from "./url-state";

const base: UrlState = {
  bbox: [-72.52, 44.91, -72.48, 44.95],
  shape: "rectangle",
  silhouette: false,
  areaId: null,
  rotation: 0,
  widthInches: 6,
  heightInches: 6,
  baseThicknessInches: 0.25,
  plinthLiftInches: 0,
  reliefInches: 1.25,
  aspectLocked: true,
  scaleDenominator: null,
  gridSize: 256,
  engraveLabel: false,
  engraveBrand: true,
  showRuns: true,
  showLifts: true,
  followConnected: false,
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

  it("round-trips the height above the name plate and omits it at zero", () => {
    expect(encodeUrlState(base).has("pl")).toBe(false);
    const params = encodeUrlState({ ...base, plinthLiftInches: 0.1 });
    expect(params.get("pl")).toBe("0.1");
    expect(decodeUrlState(params).plinthLiftInches).toBe(0.1);
    expect(decodeUrlState(new URLSearchParams("pl=-1")).plinthLiftInches).toBeUndefined();
  });

  it("ignores the retired stacked-finish setting in an old link", () => {
    const decoded = decodeUrlState(new URLSearchParams("ln=8&rh=1.5"));
    expect(decoded).not.toHaveProperty("layerCount");
    expect(decoded.reliefInches).toBe(1.5);
  });

  it("round-trips the name plate's second line and omits it when empty", () => {
    expect(encodeUrlState(base).has("place")).toBe(false);
    const params = encodeUrlState({ ...base, place: "Carrabassett Valley, ME" });
    expect(decodeUrlState(params).place).toBe("Carrabassett Valley, ME");
    expect(decodeUrlState(new URLSearchParams(params.toString())).place).toBe("Carrabassett Valley, ME");
  });

  it("trims a second line from a link and cuts it to the field's length", () => {
    expect(decodeUrlState(new URLSearchParams("place=%20%20")).place).toBeUndefined();
    expect(decodeUrlState(new URLSearchParams("place=%20Jay,%20VT%20")).place).toBe("Jay, VT");
    expect(decodeUrlState(new URLSearchParams({ place: "x".repeat(200) })).place).toHaveLength(60);
  });

  it("round-trips the ski area id", () => {
    expect(encodeUrlState(base).has("ra")).toBe(false);
    expect(decodeUrlState(encodeUrlState({ ...base, areaId: "abc123" })).areaId).toBe("abc123");
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
      followConnected: true,
      minRunWidthMm: 1.6,
      colorScheme: "eu",
    });
    expect(params.get("runs")).toBe("0");
    expect(params.get("lf")).toBe("0");
    expect(params.get("fc")).toBe("1");
    expect(params.get("mw")).toBe("1.6");
    expect(params.get("cs")).toBe("eu");

    const decoded = decodeUrlState(params);
    expect(decoded.showRuns).toBe(false);
    expect(decoded.showLifts).toBe(false);
    expect(decoded.followConnected).toBe(true);
    expect(decoded.minRunWidthMm).toBe(1.6);
    expect(decoded.colorScheme).toBe("eu");
  });

  it("leaves following connected runs off unless the link says 1", () => {
    expect(decodeUrlState(new URLSearchParams("")).followConnected).toBeUndefined();
    expect(decodeUrlState(new URLSearchParams("fc=0")).followConnected).toBeUndefined();
    expect(decodeUrlState(new URLSearchParams("fc=yes")).followConnected).toBeUndefined();
  });

  it("ignores junk values", () => {
    const decoded = decodeUrlState(new URLSearchParams("mw=abc&cs=mars&mw=-1"));
    expect(decoded.minRunWidthMm).toBeUndefined();
    expect(decoded.colorScheme).toBeUndefined();
  });
});

describe("sizing url state", () => {
  it("leaves the scale out when the size is set", () => {
    expect(encodeUrlState(base).has("sc")).toBe(false);
    expect(decodeUrlState(encodeUrlState(base)).scaleDenominator).toBeUndefined();
  });

  it("round-trips a set scale", () => {
    const params = encodeUrlState({ ...base, scaleDenominator: 25_000 });
    expect(params.get("sc")).toBe("25000");
    expect(decodeUrlState(params).scaleDenominator).toBe(25_000);
  });

  it("holds a scale from a link within range and ignores one that isn't a number", () => {
    expect(decodeUrlState(new URLSearchParams("sc=3")).scaleDenominator).toBe(1_000);
    expect(decodeUrlState(new URLSearchParams("sc=abc")).scaleDenominator).toBeUndefined();
    expect(decodeUrlState(new URLSearchParams("sc=-5")).scaleDenominator).toBeUndefined();
  });
});
