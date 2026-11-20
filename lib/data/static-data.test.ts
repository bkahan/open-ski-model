import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cellsTouching,
  extentOf,
  fetchGzipJson,
  fetchRequiredJson,
  foldName,
  intersects,
  nameMatchScore,
} from "./static-data";

function stubFetch(respond: () => Response) {
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGzipJson", () => {
  it("fetches once for concurrent and later callers", async () => {
    const fetchMock = stubFetch(() => new Response(gzipSync(JSON.stringify({ v: 1 }))));
    const url = "https://data.test/cells/1/1.json.gz";
    const [a, b] = await Promise.all([fetchGzipJson(url), fetchGzipJson(url)]);
    expect(a).toEqual({ v: 1 });
    expect(b).toBe(a);
    await fetchGzipJson(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("remembers that a cell is not there", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 404 }));
    const url = "https://data.test/cells/2/2.json.gz";
    expect(await fetchGzipJson(url)).toBeNull();
    expect(await fetchGzipJson(url)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a server error and asks again next time", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 503 }));
    const url = "https://data.test/cells/3/3.json.gz";
    await expect(fetchGzipJson(url)).rejects.toThrow("HTTP 503");
    await expect(fetchGzipJson(url)).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchRequiredJson", () => {
  it("throws while the file is missing, then picks it up once published", async () => {
    const url = "https://data.test/index.json";
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(fetchRequiredJson(url)).rejects.toThrow("not found");
    stubFetch(() => new Response(JSON.stringify({ v: 1, places: [] })));
    expect(await fetchRequiredJson(url)).toEqual({ v: 1, places: [] });
  });
});

describe("intersects", () => {
  it("counts boxes that only touch along an edge", () => {
    expect(intersects([0, 0, 1, 1], [1, 0, 2, 1])).toBe(true);
    expect(intersects([0, 0, 1, 1], [1.01, 0, 2, 1])).toBe(false);
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

  it("matches nothing for an empty query", () => {
    expect(nameMatchScore("Mount Adams", "")).toBe(0);
  });
});
