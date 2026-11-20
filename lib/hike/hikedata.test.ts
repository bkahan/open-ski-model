import { describe, expect, it } from "vitest";

import { assembleHike, searchPlaces } from "./hikedata";

type Line = [number, number][];

const bbox: [number, number, number, number] = [-71.4, 44.2, -71.2, 44.4];

const pond: Line = [[-71.32, 44.258], [-71.318, 44.258], [-71.318, 44.26], [-71.32, 44.26], [-71.32, 44.258]];
const island: Line = [[-71.3195, 44.2585], [-71.319, 44.2585], [-71.319, 44.259], [-71.3195, 44.2585]];
const farPond: Line = [[-70.1, 44.0], [-70.0, 44.0], [-70.0, 44.1], [-70.1, 44.0]];

const cellA = {
  v: 1,
  trails: [
    { id: "w1", n: "Crawford Path", g: [[-71.39, 44.22], [-71.31, 44.26]] as Line },
    { id: "w2", n: null, i: 1 as const, g: [[-71.3, 44.27], [-71.29, 44.28]] as Line },
    { id: "w3", n: "Far Trail", g: [[-70.9, 44.0], [-70.8, 44.1]] as Line },
  ],
  pois: [
    { id: "n1", k: "peak" as const, n: "Mount Washington", e: 1917, c: [-71.3033, 44.2705] as [number, number] },
    { id: "n2", k: "hut" as const, n: null, c: [-71.319, 44.2588] as [number, number] },
    { id: "n3", k: "peak" as const, n: "Mount Mansfield", e: 1339, c: [-72.8143, 44.5437] as [number, number] },
  ],
  water: [
    { id: "r1", n: "Lakes of the Clouds", p: [[pond, island], [farPond]] },
  ],
};

// The trail and peak written again to a neighboring cell, as the build
// script does for features that span cells.
const cellB = { v: 1, trails: [cellA.trails[0]], pois: [cellA.pois[0]], water: [cellA.water[0]] };

describe("assembleHike", () => {
  const data = assembleHike([cellA, cellB], bbox);

  it("dedupes features repeated across cells", () => {
    expect(data.trails.filter((t) => t.id === "w1")).toHaveLength(1);
    expect(data.pois.filter((p) => p.id === "n1")).toHaveLength(1);
    expect(data.water.filter((w) => w.id === "r1:0")).toHaveLength(1);
  });

  it("drops features outside the bbox", () => {
    expect(data.trails.map((t) => t.id)).toEqual(["w1", "w2"]);
    expect(data.pois.map((p) => p.id)).toEqual(["n1", "n2"]);
  });

  it("unpacks names, the informal flag and elevations", () => {
    expect(data.trails[0]).toMatchObject({ name: "Crawford Path", informal: false });
    expect(data.trails[1]).toMatchObject({ name: undefined, informal: true });
    expect(data.pois[0]).toMatchObject({ kind: "peak", elevationMeters: 1917, at: [-71.3033, 44.2705] });
    expect(data.pois[1].elevationMeters).toBeUndefined();
  });

  it("splits a multi-part lake, keeps holes, and drops parts outside the bbox", () => {
    expect(data.water).toEqual([{ id: "r1:0", name: "Lakes of the Clouds", outer: pond, holes: [island] }]);
  });

  it("reports the extent of the trails", () => {
    expect(data.extent).toEqual([-71.39, 44.22, -71.29, 44.28]);
    expect(data.bbox).toEqual(bbox);
  });

  it("returns an empty result with null extent for empty cells", () => {
    const empty = assembleHike([{ v: 1, trails: [], pois: [], water: [] }], bbox);
    expect(empty).toEqual({ trails: [], pois: [], water: [], bbox, extent: null });
  });
});

describe("searchPlaces", () => {
  // In index order: ranges, peaks by height, trails by length, huts.
  const index = {
    v: 1,
    places: [
      { id: "n31", n: "Presidential Range", k: "range" as const, r: "NH", c: [-71.3, 44.27] as [number, number] },
      { id: "n1", n: "Mount Washington", k: "peak" as const, r: "NH", c: [-71.3033, 44.2705] as [number, number], e: 1917 },
      { id: "n9", n: "Mount Washington", k: "peak" as const, r: "MA", c: [-73.45, 42.1] as [number, number], e: 640 },
      { id: "tw1", n: "Washington Loop", k: "trail" as const, r: "NY", c: [-74, 43] as [number, number], b: [-74.1, 42.9, -73.9, 43.1] as [number, number, number, number], km: 6.4 },
      { id: "n5", n: "Lakes of the Clouds Hut", k: "hut" as const, r: "NH", c: [-71.319, 44.2588] as [number, number] },
    ],
  };

  it("ranks by match first, then keeps index order within a tier", () => {
    expect(searchPlaces(index, "washington").map((h) => h.id)).toEqual(["tw1", "n1", "n9"]);
    expect(searchPlaces(index, "mount washington").map((h) => h.id)).toEqual(["n1", "n9"]);
  });

  it("unpacks kind, region, bbox and stats", () => {
    expect(searchPlaces(index, "presidential")[0]).toEqual({
      id: "n31",
      name: "Presidential Range",
      kind: "range",
      region: "NH",
      center: [-71.3, 44.27],
      bbox: null,
      elevationMeters: undefined,
      lengthKm: undefined,
    });
    expect(searchPlaces(index, "washington loop")[0]).toMatchObject({ bbox: [-74.1, 42.9, -73.9, 43.1], lengthKm: 6.4 });
  });

  it("honors the limit and returns nothing for a blank query", () => {
    expect(searchPlaces(index, "washington", 2)).toHaveLength(2);
    expect(searchPlaces(index, "  ")).toEqual([]);
  });
});
