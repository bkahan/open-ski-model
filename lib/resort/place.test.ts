import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResortData, SkiLift, SkiRun } from "@/lib/resort/types";
import type { Bbox, LngLat } from "@/lib/types";

import { lookupPlace, placeFromIndex, placeFromNominatim, placeLine, resortBasePoint } from "./place";

describe("placeLine", () => {
  it("abbreviates US states and Canadian provinces after a town", () => {
    expect(placeLine({ town: "Jay", region: "Vermont", country: "United States", countryCode: "US" })).toBe("Jay, VT");
    expect(
      placeLine({ town: "Carrabassett Valley", region: "Maine", country: "United States", countryCode: "US" }),
    ).toBe("Carrabassett Valley, ME");
    expect(placeLine({ town: "Whistler", region: "British Columbia", country: "Canada", countryCode: "CA" })).toBe(
      "Whistler, BC",
    );
  });

  it("spells the state out when there is no town to go with it", () => {
    expect(placeLine({ town: null, region: "Vermont", country: "United States", countryCode: "US" })).toBe("Vermont");
  });

  it("names the country everywhere else", () => {
    expect(placeLine({ town: "Zermatt", region: "Valais", country: "Switzerland", countryCode: "CH" })).toBe(
      "Zermatt, Switzerland",
    );
    expect(placeLine({ town: null, region: "Hokkaido Prefecture", country: "Japan", countryCode: "JP" })).toBe(
      "Hokkaido Prefecture, Japan",
    );
  });

  it("is empty when nothing is known", () => {
    expect(placeLine({ town: null, region: null, country: null, countryCode: null })).toBe("");
  });
});

describe("placeFromIndex", () => {
  it("reads the town only when the index has three parts", () => {
    expect(placeFromIndex("Whistler, British Columbia, Canada", "CA")).toEqual({
      town: "Whistler",
      region: "British Columbia",
      country: "Canada",
      countryCode: "CA",
    });
    expect(placeFromIndex("Vermont, United States", "us")).toEqual({
      town: null,
      region: "Vermont",
      country: "United States",
      countryCode: "US",
    });
  });

  it("copes with a missing location", () => {
    expect(placeFromIndex(null, null)).toEqual({ town: null, region: null, country: null, countryCode: null });
  });
});

describe("placeFromNominatim", () => {
  it("prefers the town over anything smaller that comes with it", () => {
    const parts = placeFromNominatim({
      village: "Sugarbush Village",
      town: "Warren",
      state: "Vermont",
      country: "United States",
      country_code: "us",
    });
    expect(placeLine(parts)).toBe("Warren, VT");
  });

  it("falls back through village and municipality", () => {
    expect(placeFromNominatim({ village: "Big Sky", state: "Montana", country_code: "us" }).town).toBe("Big Sky");
    expect(placeFromNominatim({ municipality: "Zermatt", country_code: "ch" }).town).toBe("Zermatt");
    expect(placeFromNominatim({ state: "Vermont" }).town).toBeNull();
  });
});

describe("lookupPlace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the point's address in English and reads the town from it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ address: { town: "Jay", state: "Vermont", country: "United States", country_code: "us" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const parts = await lookupPlace([-72.5056, 44.9297]);
    expect(parts && placeLine(parts)).toBe("Jay, VT");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/reverse");
    expect(url.searchParams.get("lat")).toBe("44.92970");
    expect(url.searchParams.get("lon")).toBe("-72.50560");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("accept-language")).toBe("en");
  });

  it("passes the caller's signal on and ignores fields that aren't text", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ address: { town: " Stowe ", state: 50, country: null, country_code: "us" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    expect(await lookupPlace([-72.7, 44.5], ctrl.signal)).toEqual({
      town: "Stowe",
      region: null,
      country: null,
      countryCode: "US",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it("gives null for a reply that isn't an address", async () => {
    for (const body of [null, "busy", { address: "Vermont" }, { address: null }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
      expect(await lookupPlace([0, 0])).toBeNull();
    }
  });

  it("gives null for a point with no address and throws on a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unable to geocode" })));
    expect(await lookupPlace([0, 0])).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    await expect(lookupPlace([0, 0])).rejects.toThrow("429");
  });
});

describe("resortBasePoint", () => {
  const bbox: Bbox = [-72.6, 44.9, -72.4, 45];
  const summit: LngLat = [-72.52, 44.93];
  const mainBase: LngLat = [-72.5, 44.94];
  const upperBase: LngLat = [-72.51, 44.925];
  const AREA = "jay";

  const run = (id: string, from: LngLat, to: LngLat, areas = [AREA]): SkiRun => ({
    id,
    difficulty: "easy",
    convention: "north_america",
    coords: [from, to],
    isArea: false,
    areas,
  });
  const lift = (id: string, from: LngLat, to: LngLat, areas = [AREA]): SkiLift => ({
    id,
    type: "chair_lift",
    coords: [from, to],
    areas,
  });
  const resortOf = (runs: SkiRun[], lifts: SkiLift[]): ResortData => ({
    runs,
    lifts,
    bbox,
    extent: bbox,
    convention: "north_america",
  });

  it("picks the lift station the most runs finish at, whichever way the lift is drawn", () => {
    const runs = [
      run("1", summit, mainBase),
      run("2", summit, mainBase),
      run("3", summit, mainBase),
      run("4", summit, upperBase),
    ];
    const drawnUphill = resortOf(runs, [lift("a", mainBase, summit), lift("b", upperBase, summit)]);
    const drawnDownhill = resortOf(runs, [lift("a", summit, mainBase), lift("b", summit, upperBase)]);
    expect(resortBasePoint(drawnUphill, AREA)).toEqual(mainBase);
    expect(resortBasePoint(drawnDownhill, AREA)).toEqual(mainBase);
  });

  it("does not mistake a summit where runs begin for a base", () => {
    const runs = [run("1", summit, mainBase), run("2", summit, upperBase), run("3", summit, upperBase)];
    const base = resortBasePoint(resortOf(runs, [lift("a", mainBase, summit), lift("b", upperBase, summit)]), AREA);
    expect(base).toEqual(upperBase);
  });

  it("passes over a mid-station that more runs leave than reach", () => {
    const mid: LngLat = [-72.51, 44.935];
    const runs = [
      run("1", summit, mid),
      run("2", summit, mid),
      run("3", summit, mid),
      run("4", mid, mainBase),
      run("5", mid, mainBase),
      run("6", mid, upperBase),
      run("7", mid, upperBase),
    ];
    const lifts = [lift("a", mainBase, mid), lift("b", mid, summit)];
    expect(resortBasePoint(resortOf(runs, lifts), AREA)).toEqual(mainBase);
  });

  it("uses a run's end, the one nearest where they finish, when no lift gathers them", () => {
    const farBase: LngLat = [-72.48, 44.95];
    const runs = [run("1", summit, mainBase), run("2", summit, mainBase), run("3", summit, farBase)];
    expect(resortBasePoint(resortOf(runs, []), AREA)).toEqual(mainBase);
  });

  it("gives null when the loaded data is for another ski area", () => {
    const other = resortOf([run("1", summit, mainBase, ["burke"])], [lift("a", mainBase, summit, ["burke"])]);
    expect(resortBasePoint(other, AREA)).toBeNull();
    expect(resortBasePoint(resortOf([], []), AREA)).toBeNull();
  });
});
