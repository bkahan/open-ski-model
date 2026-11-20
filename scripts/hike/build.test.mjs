import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../build-hike-data.mjs", import.meta.url));

const feature = (id, properties, type, coordinates) => ({ type: "Feature", id, properties, geometry: { type, coordinates } });
const pond = [[-71.32, 44.258], [-71.319, 44.258], [-71.319, 44.2587], [-71.32, 44.2587], [-71.32, 44.258]];
const greatLake = [[-80, 41], [-74, 41], [-74, 45], [-80, 45], [-80, 41]];
// Crosses 44° N at the Maine line, so it lands in two cells and both extracts.
const borderTrail = feature("w1", { highway: "path", name: "Border Trail" }, "LineString", [[-71.01, 43.99], [-70.99, 44.01]]);

const newHampshire = [
  { ...borderTrail, properties: { ...borderTrail.properties, region: "NH" } },
  feature("w2", { natural: "water", name: "Star Lake", region: "NH" }, "LineString", pond),
  feature("w2", { natural: "water", name: "Star Lake", region: "NH" }, "MultiPolygon", [[pond]]),
  feature("n1", { natural: "peak", name: "Mount Washington", ele: "1916.6", region: "NH" }, "Point", [-71.3033, 44.2705]),
  feature("n31", { natural: "mountain_range", name: "Presidential Range", region: "NH" }, "Point", [-71.3, 44.27]),
  feature("r9", { natural: "water", name: "Lake Erie", region: "NH" }, "MultiPolygon", [[greatLake]]),
  feature("w3", { highway: "residential", name: "Not A Trail", region: "NH" }, "LineString", [[-71.3, 44.2], [-71.2, 44.3]]),
];
const maine = [{ ...borderTrail, properties: { ...borderTrail.properties, region: "ME" } }];

let dir;
let out;
const readCell = (path) => JSON.parse(gunzipSync(readFileSync(join(out, "cells", path))).toString("utf8"));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hike-build-"));
  out = join(dir, "out");
  const sources = [newHampshire, maine].map((features, i) => {
    const path = join(dir, `${i}.geojsonseq`);
    writeFileSync(path, features.map((f) => JSON.stringify(f)).join("\n") + "\n");
    return path;
  });
  execFileSync(process.execPath, [script, out, ...sources], { stdio: "pipe" });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("build-hike-data", () => {
  it("writes a trail to every cell it touches, under west-negative paths", () => {
    const trail = { id: "w1", n: "Border Trail", g: [[-71.01, 43.99], [-70.99, 44.01]] };
    for (const cell of ["43/-72.json.gz", "43/-71.json.gz", "44/-72.json.gz", "44/-71.json.gz"]) {
      expect(readCell(cell).trails).toEqual([trail]);
    }
  });

  it("keeps a feature from two overlapping extracts once, under the first region", () => {
    const { places } = JSON.parse(readFileSync(join(out, "hike-places.json"), "utf8"));
    expect(places.filter((p) => p.k === "trail")).toMatchObject([{ id: "tw1", n: "Border Trail", r: "NH" }]);
    expect(JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"))).toMatchObject({ trails: 1, features: 8 });
  });

  it("takes a closed way's area copy for a lake and ignores its line copy", () => {
    const cell = readCell("44/-72.json.gz");
    expect(cell.water).toEqual([{ id: "w2", n: "Star Lake", p: [[pond]] }]);
    expect(cell.pois).toEqual([{ id: "n1", k: "peak", n: "Mount Washington", e: 1917, c: [-71.3033, 44.2705] }]);
  });

  it("skips water that spans too many cells, and counts it", () => {
    expect(existsSync(join(out, "cells", "42"))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"))).toMatchObject({ water: 1, skipped: 1 });
  });

  it("orders the index ranges first, then peaks, then trails", () => {
    const { v, places } = JSON.parse(readFileSync(join(out, "hike-places.json"), "utf8"));
    expect(v).toBe(1);
    expect(places.map((p) => p.id)).toEqual(["n31", "n1", "tw1"]);
  });
});
