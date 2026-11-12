import { describe, expect, it } from "vitest";

import {
  clampScaleDenominator,
  exaggerationForRelief,
  fitDragToPrint,
  printFrame,
  reliefForRescaledPrint,
  reliefForResizedPrint,
  scaleDenominator,
  scaleForResizedPrint,
} from "./print-fit";

const six = { widthInches: 6, heightInches: 6 };

describe("fitDragToPrint", () => {
  it("keeps the print size and widens the coverage on an outward drag", () => {
    const fitted = fitDragToPrint({ widthInches: 9, heightInches: 9 }, six, 1000)!;
    expect(fitted.widthInches).toBeCloseTo(6);
    expect(fitted.heightInches).toBeCloseTo(6);
    expect(fitted.metersPerInch).toBeCloseTo(1500);
  });

  it("keeps the ground area the drag asked for", () => {
    const dragged = { widthInches: 4, heightInches: 3 };
    const fitted = fitDragToPrint(dragged, six, 1000)!;
    expect(fitted.widthInches * fitted.metersPerInch).toBeCloseTo(4000);
    expect(fitted.heightInches * fitted.metersPerInch).toBeCloseTo(3000);
  });

  it("holds the longest side when the aspect changes", () => {
    const fitted = fitDragToPrint({ widthInches: 3, heightInches: 8 }, six, 1000)!;
    expect(fitted.heightInches).toBeCloseTo(6);
    expect(fitted.widthInches).toBeCloseTo(2.25);
  });

  it("refuses coverage outside the supported range", () => {
    expect(fitDragToPrint({ widthInches: 2, heightInches: 2 }, six, 90)).toBeNull();
    expect(fitDragToPrint({ widthInches: 24, heightInches: 24 }, six, 8000)).toBeNull();
  });
});

describe("resizing the print", () => {
  const eight = { widthInches: 8, heightInches: 8 };

  it("keeps the ground coverage", () => {
    expect(scaleForResizedPrint(six, eight, 1000) * 8).toBeCloseTo(6000);
  });

  it("scales the model height with it", () => {
    expect(reliefForResizedPrint(six, eight, 1.5)).toBeCloseTo(2);
    expect(reliefForResizedPrint(six, six, 1.5)).toBeCloseTo(1.5);
  });
});

describe("exaggerationForRelief", () => {
  it("gives big and small resorts the same printed height", () => {
    const big = { reliefMeters: 1600, inchesPerMeter: 6 / 25_000 };
    const small = { reliefMeters: 300, inchesPerMeter: 6 / 4_000 };
    const printed = ({ reliefMeters, inchesPerMeter }: typeof big) =>
      reliefMeters * inchesPerMeter * exaggerationForRelief(1.25, reliefMeters, inchesPerMeter);
    expect(printed(big)).toBeCloseTo(1.25);
    expect(printed(small)).toBeCloseTo(1.25);
  });

  it("stops short of spiking nearly flat ground", () => {
    expect(exaggerationForRelief(1.25, 5, 6 / 25_000)).toBe(8);
  });

  it("falls back to true scale with no relief", () => {
    expect(exaggerationForRelief(1.25, 0, 6 / 5_000)).toBe(1);
  });
});

describe("printFrame", () => {
  // Six inches square over 3,048 m of ground: 508 m to the inch, 1 : 20,000.
  const layout = { size: six, metersPerInch: 508, outlineShare: null };

  it("is the layout itself when the size is set", () => {
    const frame = printFrame({ ...layout, sizing: { mode: "size" } });
    expect(frame.widthInches).toBe(6);
    expect(frame.heightInches).toBe(6);
    expect(frame.metersPerInch).toBe(508);
    expect(frame.stated).toEqual(six);
    expect(scaleDenominator(frame.metersPerInch)).toBeCloseTo(20_000, 6);
  });

  it("covers the same ground at a set scale, however big that makes the print", () => {
    const frame = printFrame({ ...layout, sizing: { mode: "scale", denominator: 10_000 } });
    expect(frame.widthInches).toBeCloseTo(12, 9);
    expect(frame.heightInches).toBeCloseTo(12, 9);
    expect(scaleDenominator(frame.metersPerInch)).toBeCloseTo(10_000, 6);
    expect(frame.widthInches * frame.metersPerInch).toBeCloseTo(6 * 508, 6);
    expect(frame.stated.widthInches).toBeCloseTo(12, 9);
  });

  it("keeps a layout's proportions at a set scale", () => {
    const wide = { size: { widthInches: 8, heightInches: 5 }, metersPerInch: 254, outlineShare: null };
    const frame = printFrame({ ...wide, sizing: { mode: "scale", denominator: 20_000 } });
    expect(frame.widthInches).toBeCloseTo(4, 9);
    expect(frame.heightInches).toBeCloseTo(2.5, 9);
  });

  it("enlarges a resort's frame so the mountain, not the frame, is the set size", () => {
    const frame = printFrame({ ...layout, outlineShare: 0.9, sizing: { mode: "size" } });
    expect(frame.widthInches).toBeCloseTo(6 / 0.9, 9);
    expect(frame.stated.widthInches).toBeCloseTo(6, 9);
    // Same ground under a bigger frame: finer scale.
    expect(frame.widthInches * frame.metersPerInch).toBeCloseTo(6 * 508, 6);
  });

  it("states the mountain's size, not its frame's, at a set scale", () => {
    const frame = printFrame({ ...layout, outlineShare: 0.9, sizing: { mode: "scale", denominator: 10_000 } });
    expect(frame.widthInches).toBeCloseTo(12, 9);
    expect(frame.stated.widthInches).toBeCloseTo(10.8, 9);
    expect(scaleDenominator(frame.metersPerInch)).toBeCloseTo(10_000, 6);
  });
});

describe("clampScaleDenominator", () => {
  it("rounds, and holds the scale between 1 : 1,000 and 1 : 500,000", () => {
    expect(clampScaleDenominator(24_999.6)).toBe(25_000);
    expect(clampScaleDenominator(12)).toBe(1_000);
    expect(clampScaleDenominator(9e9)).toBe(500_000);
    expect(clampScaleDenominator(Number.NaN)).toBe(1_000);
  });
});

describe("reliefForRescaledPrint", () => {
  it("doubles the model height when the scale makes the print twice as big", () => {
    expect(reliefForRescaledPrint(0.75, 20_000, 10_000)).toBeCloseTo(1.5, 9);
    expect(reliefForRescaledPrint(1.5, 10_000, 20_000)).toBeCloseTo(0.75, 9);
  });

  it("stops at what the height slider can hold", () => {
    expect(reliefForRescaledPrint(2, 50_000, 5_000)).toBe(4);
    expect(reliefForRescaledPrint(0.5, 5_000, 50_000)).toBe(0.25);
  });
});
