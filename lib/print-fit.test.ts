import { describe, expect, it } from "vitest";

import {
  exaggerationForRelief,
  fitDragToPrint,
  reliefForResizedPrint,
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
