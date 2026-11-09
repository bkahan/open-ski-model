import { describe, expect, it } from "vitest";

import { colorSchemeForBbox, resolveColorScheme, runColor } from "./colors";

describe("color schemes", () => {
  it("reads intermediate as blue in North America and red in Europe", () => {
    expect(runColor("intermediate", "na").name).toBe("blue");
    expect(runColor("intermediate", "eu").name).toBe("red");
  });

  it("reads easy as green in North America and blue in Europe", () => {
    expect(runColor("easy", "na").name).toBe("green");
    expect(runColor("easy", "eu").name).toBe("blue");
  });

  it("picks the scheme from longitude", () => {
    expect(colorSchemeForBbox([-72.55, 44.9, -72.45, 44.96])).toBe("na");
    expect(colorSchemeForBbox([6.8, 45.9, 6.9, 46])).toBe("eu");
    expect(colorSchemeForBbox([138.7, 36.6, 138.8, 36.7])).toBe("eu");
  });

  it("auto resolves by bbox and explicit settings win", () => {
    const alps: [number, number, number, number] = [6.8, 45.9, 6.9, 46];
    expect(resolveColorScheme("auto", alps)).toBe("eu");
    expect(resolveColorScheme("na", alps)).toBe("na");
  });
});
