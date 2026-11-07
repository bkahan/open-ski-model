import { describe, expect, it } from "vitest";

import { buildOverpassQuery, parseOverpass, type OverpassElement } from "./overpass";

const bbox: [number, number, number, number] = [-72.55, 44.9, -72.45, 44.96];

const elements: OverpassElement[] = [
  {
    type: "way",
    id: 1,
    tags: { "piste:type": "downhill", "piste:difficulty": "easy", name: "Ullr's Dream" },
    geometry: [
      { lat: 44.93, lon: -72.5 },
      { lat: 44.931, lon: -72.501 },
    ],
  },
  {
    type: "way",
    id: 2,
    tags: { "piste:type": "downhill", "piste:difficulty": "weird", "piste:name": "Glade" },
    geometry: [
      { lat: 44.94, lon: -72.49 },
      { lat: 44.941, lon: -72.491 },
      { lat: 44.94, lon: -72.49 },
    ],
  },
  {
    type: "way",
    id: 3,
    tags: { "piste:type": "downhill", "piste:difficulty": "advanced", "area:piste": "yes" },
    geometry: [
      { lat: 44.95, lon: -72.47 },
      { lat: 44.951, lon: -72.47 },
      { lat: 44.951, lon: -72.471 },
      { lat: 44.95, lon: -72.47 },
    ],
  },
  {
    type: "way",
    id: 4,
    tags: { aerialway: "chair_lift", name: "Jet Triple" },
    geometry: [
      { lat: 44.92, lon: -72.52 },
      { lat: 44.935, lon: -72.5 },
    ],
  },
  {
    type: "way",
    id: 5,
    tags: { aerialway: "goods" },
    geometry: [
      { lat: 44.92, lon: -72.52 },
      { lat: 44.925, lon: -72.51 },
    ],
  },
  {
    type: "way",
    id: 6,
    tags: { aerialway: "funicular" },
    geometry: [
      { lat: 44.92, lon: -72.52 },
      { lat: 44.925, lon: -72.51 },
    ],
  },
  {
    type: "node",
    id: 7,
    tags: { aerialway: "station" },
  },
  {
    type: "way",
    id: 8,
    tags: { "piste:type": "downhill" },
    geometry: [{ lat: 44.92, lon: -72.52 }],
  },
];

describe("parseOverpass", () => {
  const data = parseOverpass(elements, bbox);

  it("keeps downhill runs with at least two points", () => {
    expect(data.runs.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("prefers piste:name over name and tolerates missing names", () => {
    expect(data.runs[0].name).toBe("Ullr's Dream");
    expect(data.runs[1].name).toBe("Glade");
    expect(data.runs[2].name).toBeUndefined();
  });

  it("maps unknown difficulties to unknown", () => {
    expect(data.runs.map((r) => r.difficulty)).toEqual(["easy", "unknown", "advanced"]);
  });

  it("flags polygons only when tagged as an area", () => {
    expect(data.runs.map((r) => r.isArea)).toEqual([false, false, true]);
  });

  it("drops goods lifts and station nodes, keeps unknown lift kinds as other", () => {
    expect(data.lifts.map((l) => [l.id, l.type])).toEqual([
      [4, "chair_lift"],
      [6, "other"],
    ]);
  });

  it("stores lng/lat order and the extent of everything kept", () => {
    expect(data.runs[0].coords[0]).toEqual([-72.5, 44.93]);
    expect(data.extent).toEqual([-72.52, 44.92, -72.47, 44.951]);
    expect(data.bbox).toEqual(bbox);
  });

  it("returns a null extent for an empty area", () => {
    expect(parseOverpass([], bbox).extent).toBeNull();
  });
});

describe("buildOverpassQuery", () => {
  it("orders the bbox south,west,north,east as Overpass expects", () => {
    const q = buildOverpassQuery(bbox);
    expect(q).toContain("(44.9,-72.55,44.96,-72.45)");
    expect(q).toContain('["piste:type"="downhill"]');
    expect(q).toContain('["aerialway"]');
    expect(q).toContain("out tags geom");
  });
});
