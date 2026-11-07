import { describe, expect, it } from "vitest";

import { assembleResort, cellsTouching, searchIndex } from "./skidata";

const bbox: [number, number, number, number] = [-72.55, 44.9, -72.45, 44.96];

const cellA = {
  v: 1,
  runs: [
    { id: "r1", n: "Ullr's Dream", d: "easy" as const, c: "north_america" as const, a: ["sa1"], g: [[[-72.5, 44.93], [-72.49, 44.94]] as [number, number][]] },
    { id: "r2", n: null, d: null, c: "north_america" as const, a: [], g: [[[-72.52, 44.92], [-72.51, 44.925]], [[-72.48, 44.95], [-72.47, 44.955]]] as [number, number][][] },
    { id: "r3", n: "Far away", d: "expert" as const, c: "europe" as const, a: [], g: [[[-72.9, 44.1], [-72.89, 44.11]] as [number, number][]] },
    { id: "r4", n: "Bowl", d: "advanced" as const, c: "north_america" as const, a: [], p: [[[-72.5, 44.91], [-72.49, 44.91], [-72.49, 44.92], [-72.5, 44.91]] as [number, number][]] },
  ],
  lifts: [
    { id: "l1", n: "Jet", t: "chair_lift", a: ["sa1"], g: [[[-72.52, 44.92], [-72.5, 44.93]] as [number, number][]] },
    { id: "l2", n: null, t: "zip_line", a: [], g: [[[-72.52, 44.92], [-72.5, 44.93]] as [number, number][]] },
  ],
};

// The same run written to a neighboring cell, as the build script does
// for features that span cells.
const cellB = { v: 1, runs: [cellA.runs[0]], lifts: [cellA.lifts[0]] };

describe("assembleResort", () => {
  const data = assembleResort([cellA, cellB], bbox);

  it("dedupes features repeated across cells", () => {
    expect(data.runs.filter((r) => r.id === "r1")).toHaveLength(1);
    expect(data.lifts.filter((l) => l.id === "l1")).toHaveLength(1);
  });

  it("splits multi-part runs and suffixes their ids", () => {
    expect(data.runs.map((r) => r.id).sort()).toEqual(["r1", "r2:0", "r2:1", "r4"]);
  });

  it("drops features outside the bbox", () => {
    expect(data.runs.find((r) => r.id === "r3")).toBeUndefined();
  });

  it("maps missing difficulty to unknown, unknown lift kinds to other", () => {
    expect(data.runs.find((r) => r.id === "r2:0")?.difficulty).toBe("unknown");
    expect(data.runs.find((r) => r.id === "r1")?.name).toBe("Ullr's Dream");
    expect(data.lifts.find((l) => l.id === "l2")?.type).toBe("other");
  });

  it("marks polygon runs as areas", () => {
    expect(data.runs.find((r) => r.id === "r4")?.isArea).toBe(true);
    expect(data.runs.find((r) => r.id === "r1")?.isArea).toBe(false);
  });

  it("reports the majority convention and an extent", () => {
    expect(data.convention).toBe("north_america");
    expect(data.extent).toEqual([-72.52, 44.91, -72.47, 44.955]);
    expect(data.bbox).toEqual(bbox);
  });

  it("returns an empty result with null extent for empty cells", () => {
    const empty = assembleResort([{ v: 1, runs: [], lifts: [] }], bbox);
    expect(empty.runs).toEqual([]);
    expect(empty.extent).toBeNull();
    expect(empty.convention).toBeNull();
  });
});

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

describe("searchIndex", () => {
  const index = {
    v: 1,
    areas: [
      { id: "a", n: "Jay Peak", loc: "Jay, Vermont, United States", cc: "US", conv: "north_america" as const, vh: [-72.5, 44.93, 12, 4200, 3100] as [number, number, number, number, number], runs: 80 },
      { id: "b", n: "Mont-Sainte-Anne", loc: null, cc: "CA", conv: "north_america" as const, vh: [-70.9, 47.07, 0, 3000, 2000] as [number, number, number, number, number], runs: 70 },
      { id: "c", n: "Sainte-Jay", loc: null, cc: "FR", conv: "europe" as const, vh: [6, 45, 0, 1000, 1000] as [number, number, number, number, number], runs: 5 },
      { id: "d", n: "Jáy Resort", loc: null, cc: "ES", conv: "europe" as const, vh: [0, 42, 0, 1000, 1000] as [number, number, number, number, number], runs: 3 },
    ],
  };

  it("ranks exact, then prefix, then word prefix, then substring", () => {
    expect(searchIndex(index, "jay peak").map((h) => h.id)).toEqual(["a"]);
    expect(searchIndex(index, "jay").map((h) => h.id)).toEqual(["a", "d", "c"]);
    expect(searchIndex(index, "anne").map((h) => h.id)).toEqual(["b"]);
  });

  it("ignores case and diacritics and unpacks the viewport hint", () => {
    const [hit] = searchIndex(index, "JAY RES");
    expect(hit.id).toBe("d");
    const [jay] = searchIndex(index, "Jay Peak");
    expect(jay).toMatchObject({
      center: [-72.5, 44.93],
      bearing: 12,
      widthMeters: 4200,
      heightMeters: 3100,
      location: "Jay, Vermont, United States",
      runCount: 80,
    });
  });

  it("returns nothing for a blank query", () => {
    expect(searchIndex(index, "  ")).toEqual([]);
  });
});
