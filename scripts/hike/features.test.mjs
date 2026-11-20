import { describe, expect, it } from "vitest";

import {
  cleanLine,
  comparePlaces,
  isHikingTrail,
  lineLengthKm,
  namedTrails,
  parseElevation,
  poiFrom,
  poiPlace,
  rangeFrom,
  ringSquareMeters,
  trailFrom,
  waterFrom,
} from "./features.mjs";

const feature = (id, properties, type, coordinates) => ({ type: "Feature", id, properties, geometry: { type, coordinates } });

// About 80 m by 78 m at 44° N.
const pond = [[-71.32, 44.258], [-71.319, 44.258], [-71.319, 44.2587], [-71.32, 44.2587], [-71.32, 44.258]];
const puddle = [[-71.32, 44.258], [-71.3199, 44.258], [-71.3199, 44.2581], [-71.32, 44.2581], [-71.32, 44.258]];

describe("isHikingTrail", () => {
  it("takes any unpaved path open to walkers", () => {
    expect(isHikingTrail({ highway: "path" })).toBe(true);
    expect(isHikingTrail({ highway: "path", surface: "ground" })).toBe(true);
    expect(isHikingTrail({ highway: "path", surface: "asphalt" })).toBe(false);
    expect(isHikingTrail({ highway: "path", footway: "sidewalk" })).toBe(false);
  });

  it("takes a footway only when it is named or hiking-tagged, and not a sidewalk", () => {
    expect(isHikingTrail({ highway: "footway" })).toBe(false);
    expect(isHikingTrail({ highway: "footway", name: "Tuckerman Ravine Trail" })).toBe(true);
    expect(isHikingTrail({ highway: "footway", sac_scale: "hiking" })).toBe(true);
    expect(isHikingTrail({ highway: "footway", name: "Main Street", footway: "sidewalk" })).toBe(false);
    expect(isHikingTrail({ highway: "footway", name: "Esplanade", surface: "concrete" })).toBe(false);
  });

  it("drops closed and private ways, letting foot=* outrank access=*", () => {
    expect(isHikingTrail({ highway: "path", access: "private" })).toBe(false);
    expect(isHikingTrail({ highway: "path", access: "no" })).toBe(false);
    expect(isHikingTrail({ highway: "path", foot: "discouraged" })).toBe(false);
    expect(isHikingTrail({ highway: "path", access: "private", foot: "yes" })).toBe(true);
    expect(isHikingTrail({ highway: "path", access: "yes", foot: "no" })).toBe(false);
  });

  it("is not fooled by other highways", () => {
    expect(isHikingTrail({ highway: "residential", name: "Trail Road" })).toBe(false);
    expect(isHikingTrail({ highway: "trailhead", name: "Appalachia" })).toBe(false);
  });
});

describe("trailFrom", () => {
  it("rounds to 1e-5 degrees, drops repeats and flags informal paths", () => {
    const trail = trailFrom(
      feature("w1", { highway: "path", name: "Crawford Path", informal: "yes" }, "LineString", [
        [-71.3190004, 44.2580004],
        [-71.3190001, 44.2580001],
        [-71.318, 44.259],
      ]),
    );
    expect(trail).toEqual({ id: "w1", n: "Crawford Path", i: 1, g: [[-71.319, 44.258], [-71.318, 44.259]] });
  });

  it("leaves the informal flag off, and unnamed trails with a null name", () => {
    expect(trailFrom(feature("w2", { highway: "path" }, "LineString", [[-71.3, 44.2], [-71.31, 44.21]]))).toEqual({
      id: "w2",
      n: null,
      g: [[-71.3, 44.2], [-71.31, 44.21]],
    });
  });

  it("rejects a line that collapses to a point, and the area copy of a closed way", () => {
    expect(trailFrom(feature("w3", { highway: "path" }, "LineString", [[-71.3, 44.2], [-71.3000001, 44.2]]))).toBeNull();
    expect(trailFrom(feature("w4", { highway: "path" }, "MultiPolygon", [[pond]]))).toBeNull();
  });
});

describe("parseElevation", () => {
  it("reads meters, with or without the unit", () => {
    expect(parseElevation("1916.6")).toBe(1917);
    expect(parseElevation("1917 m")).toBe(1917);
    expect(parseElevation("-12")).toBe(-12);
  });

  it("converts feet when the tag says so", () => {
    expect(parseElevation("6288 ft")).toBe(1917);
    expect(parseElevation("6288'")).toBe(1917);
  });

  it("refuses ranges, junk and impossible heights", () => {
    expect(parseElevation("1900-1917")).toBeNull();
    expect(parseElevation("6,288")).toBeNull();
    expect(parseElevation("about 1900")).toBeNull();
    expect(parseElevation("19166")).toBeNull();
    expect(parseElevation(undefined)).toBeNull();
  });
});

describe("poiFrom", () => {
  it("keeps a named peak with its elevation", () => {
    expect(poiFrom(feature("n1", { natural: "peak", name: "Mount Washington", ele: "1916.6" }, "Point", [-71.3033, 44.2705]))).toEqual({
      id: "n1",
      k: "peak",
      n: "Mount Washington",
      e: 1917,
      c: [-71.3033, 44.2705],
    });
  });

  it("drops unnamed peaks but keeps unnamed huts and trailheads", () => {
    expect(poiFrom(feature("n2", { natural: "peak" }, "Point", [-71.3, 44.27]))).toBeNull();
    expect(poiFrom(feature("n3", { tourism: "wilderness_hut" }, "Point", [-71.3, 44.27]))).toEqual({ id: "n3", k: "hut", n: null, c: [-71.3, 44.27] });
    expect(poiFrom(feature("n4", { highway: "trailhead" }, "Point", [-71.3, 44.3]))?.k).toBe("trailhead");
  });

  it("puts a hut drawn as a building at its middle, once", () => {
    const tags = { tourism: "alpine_hut", name: "Madison Spring Hut" };
    expect(poiFrom(feature("w5", tags, "MultiPolygon", [[pond]]))?.c).toEqual([-71.3195, 44.25835]);
    expect(poiFrom(feature("w5", tags, "LineString", pond))).toBeNull();
  });
});

describe("waterFrom", () => {
  it("keeps a pond as [outer, ...holes]", () => {
    const hole = [[-71.3197, 44.2582], [-71.3195, 44.2582], [-71.3195, 44.2584], [-71.3197, 44.2582]];
    expect(waterFrom(feature("r1", { natural: "water", name: "Star Lake" }, "MultiPolygon", [[pond, hole]]))).toEqual({
      id: "r1",
      n: "Star Lake",
      p: [[pond, hole]],
    });
  });

  it("drops puddles, riverbanks and the line copy of a closed way", () => {
    expect(waterFrom(feature("w1", { natural: "water" }, "MultiPolygon", [[puddle]]))).toBeNull();
    expect(waterFrom(feature("w2", { natural: "water", water: "river" }, "MultiPolygon", [[pond]]))).toBeNull();
    expect(waterFrom(feature("w3", { natural: "water" }, "LineString", pond))).toBeNull();
  });

  it("measures the water, not the island in it", () => {
    const almostAllIsland = pond.map(([x, y]) => [x + (x < -71.3195 ? 0.00002 : -0.00002), y + (y < 44.2583 ? 0.00002 : -0.00002)]);
    expect(waterFrom(feature("r2", { natural: "water" }, "MultiPolygon", [[pond, almostAllIsland]]))).toBeNull();
  });
});

describe("ringSquareMeters and lineLengthKm", () => {
  it("measure on the ground at the feature's latitude", () => {
    expect(ringSquareMeters(pond)).toBeGreaterThan(6100);
    expect(ringSquareMeters(pond)).toBeLessThan(6300);
    // 0.01° of latitude is 1.1132 km anywhere.
    expect(lineLengthKm([[-71.3, 44.2], [-71.3, 44.21]])).toBeCloseTo(1.1132, 3);
    // 0.01° of longitude at 60° N is half that.
    expect(lineLengthKm([[10, 60], [10.01, 60]])).toBeCloseTo(0.5566, 3);
  });
});

describe("rangeFrom", () => {
  it("indexes a range mapped as a point by its position alone", () => {
    expect(rangeFrom(feature("n31", { natural: "mountain_range", name: "Presidential Range", region: "NH" }, "Point", [-71.3, 44.27]))).toEqual({
      id: "n31",
      n: "Presidential Range",
      k: "range",
      r: "NH",
      c: [-71.3, 44.27],
    });
  });

  it("gives a range drawn as a line or an area its bounds", () => {
    const tags = { natural: "mountain_range", name: "Franconia Range", region: "NH" };
    expect(rangeFrom(feature("w7", tags, "LineString", [[-71.66, 44.1], [-71.64, 44.18]]))).toMatchObject({
      c: [-71.65, 44.14],
      b: [-71.66, 44.1, -71.64, 44.18],
    });
    expect(rangeFrom(feature("r7", tags, "MultiPolygon", [[pond]]))?.b).toEqual([-71.32, 44.258, -71.319, 44.2587]);
  });

  it("skips unnamed ranges", () => {
    expect(rangeFrom(feature("n32", { natural: "mountain_range", region: "NH" }, "Point", [-71.3, 44.27]))).toBeNull();
  });
});

describe("namedTrails", () => {
  const way = (id, n, g, r = "NH") => ({ id, n, g, r });

  it("joins same-name ways that are near each other into one entry", () => {
    const entries = namedTrails([
      way("w2", "Gulfside Trail", [[-71.3, 44.3], [-71.3, 44.31]]),
      way("w1", "Gulfside Trail", [[-71.3, 44.31], [-71.3, 44.32]]),
      way("w3", "Gulfside Trail", [[-71.3, 44.323], [-71.3, 44.33]]),
    ]);
    expect(entries).toEqual([
      { id: "tw1", n: "Gulfside Trail", k: "trail", r: "NH", c: [-71.3, 44.315], b: [-71.3, 44.3, -71.3, 44.33], km: 3 },
    ]);
  });

  it("keeps same-name trails that are far apart as separate entries", () => {
    const entries = namedTrails([
      way("w1", "Loop Trail", [[-71.3, 44.3], [-71.3, 44.31]]),
      way("w2", "Loop Trail", [[-73.0, 42.0], [-73.0, 42.01]], "MA"),
    ]);
    expect(entries.map((e) => [e.id, e.r])).toEqual([["tw1", "NH"], ["tw2", "MA"]]);
  });

  it("leaves out unnamed ways and trails too short to search for", () => {
    expect(
      namedTrails([
        way("w1", null, [[-71.3, 44.3], [-71.3, 44.4]]),
        way("w2", "Spur", [[-71.3, 44.3], [-71.3, 44.301]]),
      ]),
    ).toEqual([]);
  });
});

describe("poiPlace and comparePlaces", () => {
  it("indexes named peaks and huts, not trailheads or unnamed huts", () => {
    expect(poiPlace({ id: "n1", k: "peak", n: "Mount Adams", e: 1760, c: [-71.29, 44.32] }, "NH")).toEqual({
      id: "n1",
      n: "Mount Adams",
      k: "peak",
      r: "NH",
      c: [-71.29, 44.32],
      e: 1760,
    });
    expect(poiPlace({ id: "n2", k: "trailhead", n: "Appalachia", c: [-71.29, 44.37] }, "NH")).toBeNull();
    expect(poiPlace({ id: "n3", k: "hut", n: null, c: [-71.29, 44.33] }, "NH")).toBeNull();
  });

  it("orders ranges, then peaks from the highest, trails from the longest, huts", () => {
    const places = [
      { id: "n5", n: "Madison Spring Hut", k: "hut" },
      { id: "tw2", n: "Short Trail", k: "trail", km: 1 },
      { id: "n2", n: "Mount Adams", k: "peak", e: 1760 },
      { id: "tw1", n: "Long Trail", k: "trail", km: 400 },
      { id: "n3", n: "Unmeasured Peak", k: "peak" },
      { id: "n1", n: "Mount Washington", k: "peak", e: 1917 },
      { id: "n31", n: "Presidential Range", k: "range" },
    ];
    expect(places.sort(comparePlaces).map((p) => p.id)).toEqual(["n31", "n1", "n2", "n3", "tw1", "tw2", "n5"]);
  });
});

describe("cleanLine", () => {
  it("keeps a closed ring closed", () => {
    const ring = cleanLine(pond);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5);
  });
});
