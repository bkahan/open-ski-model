import { describe, expect, it } from "vitest";

import { cellsTouching, extentOf, foldName, nameMatchScore } from "./static-data";

describe("cellsTouching", () => {
  it("lists every 1° cell the bbox overlaps", () => {
    expect(cellsTouching([-72.55, 44.9, -72.45, 44.96])).toEqual([[44, -73]]);
    expect(cellsTouching([-72.2, 44.9, -71.9, 45.1])).toEqual([
      [44, -73],
      [44, -72],
      [45, -73],
      [45, -72],
    ]);
  });
});

describe("extentOf", () => {
  it("covers every line, and is null for none", () => {
    expect(extentOf([[[-71.3, 44.2], [-71.2, 44.3]], [[-71.4, 44.25], [-71.35, 44.26]]])).toEqual([-71.4, 44.2, -71.2, 44.3]);
    expect(extentOf([])).toBeNull();
  });
});

describe("nameMatchScore", () => {
  it("scores exact over prefix over word prefix over substring", () => {
    const q = foldName("Wash");
    expect(nameMatchScore("Wash", q)).toBe(4);
    expect(nameMatchScore("Washington", q)).toBe(3);
    expect(nameMatchScore("Mount Washington", q)).toBe(2);
    expect(nameMatchScore("Carwash Trail", q)).toBe(1);
    expect(nameMatchScore("Mount Adams", q)).toBe(0);
  });

  it("ignores case and diacritics", () => {
    expect(nameMatchScore("Mont-Mégantic", foldName("megantic"))).toBe(2);
  });
});
