"use client";

// Two sources, queried together: ski areas from our OpenSkiData index
// (/api/resort/search), which carry a natural viewport for framing the
// whole resort, and places from Nominatim for anything else (a summit, a
// town). Nominatim's policy: identify the app, ~1 req/s, cache.

import { useEffect, useState } from "react";

import type { SkiAreaHit } from "@/lib/resort/types";
import type { Bbox, SearchResult } from "@/lib/types";

interface Props {
  onSelect: (result: SearchResult) => void;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const DEBOUNCE_MS = 350;
const MIN_QUERY_CHARS = 2;
const METERS_PER_DEG_LAT = 111_320;

export default function SearchBar({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  // Below the minimum query length we just don't render any results — no
  // need to mirror that state in React (avoids setState-in-effect).
  const visibleResults = query.trim().length < MIN_QUERY_CHARS ? [] : results;

  useEffect(() => {
    if (query.trim().length < MIN_QUERY_CHARS) return;

    // Each source fails on its own: a Nominatim outage must not hide the
    // resort index, and vice versa.
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      const [resorts, places] = await Promise.all([
        searchResorts(query, ctrl.signal).catch((err: unknown) => {
          if (!ctrl.signal.aborted) console.warn("[search] resorts failed", err);
          return [] as SearchResult[];
        }),
        searchPlaces(query, ctrl.signal).catch((err: unknown) => {
          if (!ctrl.signal.aborted) console.warn("[search] places failed", err);
          return [] as SearchResult[];
        }),
      ]);
      if (ctrl.signal.aborted) return;
      setResults([...resorts, ...places]);
      setOpen(true);
      setLoading(false);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const resorts = visibleResults.filter((r) => r.kind === "resort");
  const places = visibleResults.filter((r) => r.kind === "place");

  const item = (r: SearchResult) => (
    <li key={`${r.kind}-${r.id}`}>
      <button
        type="button"
        className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-800"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onSelect(r);
          setQuery(r.name);
          setOpen(false);
        }}
      >
        <div className="font-medium">{r.name}</div>
        <div className="text-xs text-slate-400 truncate">{r.detail}</div>
      </button>
    </li>
  );

  const heading = (text: string) => (
    <li className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500">
      {text}
    </li>
  );

  return (
    <div className="relative">
      <input
        className="w-full rounded-md bg-slate-900/80 border border-slate-700 px-3 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
        placeholder="Search a ski resort or place&hellip;"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => visibleResults.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {loading && (
        <span className="absolute right-3 top-2.5 text-xs text-slate-500">
          searching&hellip;
        </span>
      )}
      {open && visibleResults.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-80 overflow-auto rounded-md border border-slate-700 bg-slate-900 shadow-xl">
          {resorts.length > 0 && heading("Ski resorts")}
          {resorts.map(item)}
          {places.length > 0 && heading("Places")}
          {places.map(item)}
        </ul>
      )}
    </div>
  );
}

async function searchResorts(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`/api/resort/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) {
    console.warn("[search] resort index unavailable:", res.status);
    return [];
  }
  const { results } = (await res.json()) as { results: SkiAreaHit[] };
  return results.map(resortToResult);
}

/** Axis-aligned bounds of the resort's rotated natural viewport. */
function resortToResult(hit: SkiAreaHit): SearchResult {
  const theta = (hit.bearing * Math.PI) / 180;
  const halfW = (hit.widthMeters * Math.abs(Math.cos(theta)) + hit.heightMeters * Math.abs(Math.sin(theta))) / 2;
  const halfH = (hit.widthMeters * Math.abs(Math.sin(theta)) + hit.heightMeters * Math.abs(Math.cos(theta))) / 2;
  const [lng, lat] = hit.center;
  const mPerDegLng = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const bbox: Bbox = [
    lng - halfW / mPerDegLng,
    lat - halfH / METERS_PER_DEG_LAT,
    lng + halfW / mPerDegLng,
    lat + halfH / METERS_PER_DEG_LAT,
  ];
  return {
    kind: "resort",
    id: hit.id,
    name: hit.name,
    detail: [hit.location, `${hit.runCount} runs`].filter(Boolean).join(" · "),
    bbox,
    center: hit.center,
    bearing: hit.bearing,
    convention: hit.convention,
    location: hit.location,
    countryCode: hit.countryCode,
  };
}

interface RawNominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
}

async function searchPlaces(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "0", limit: "5" });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.warn("[search] Nominatim unavailable:", res.status);
    return [];
  }
  const json = (await res.json()) as RawNominatimResult[];
  return json.map(placeToResult);
}

function placeToResult(r: RawNominatimResult): SearchResult {
  const south = parseFloat(r.boundingbox[0]);
  const north = parseFloat(r.boundingbox[1]);
  const west = parseFloat(r.boundingbox[2]);
  const east = parseFloat(r.boundingbox[3]);
  return {
    kind: "place",
    id: String(r.place_id),
    name: r.display_name.split(",")[0],
    detail: r.display_name,
    bbox: [west, south, east, north],
    center: [parseFloat(r.lon), parseFloat(r.lat)],
  };
}
