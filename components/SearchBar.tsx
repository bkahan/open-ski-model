"use client";

// Geocoding via Nominatim (OpenStreetMap's free service).
// Their usage policy asks us to:
//  - Identify the app via a User-Agent / Referer
//  - Cap requests to ~1/sec
//  - Cache where reasonable
// The free public endpoint is `nominatim.openstreetmap.org`. For production
// scale you'd run your own Nominatim or proxy through your server.

import { useEffect, useRef, useState } from "react";
import type { Bbox, SearchResult } from "@/lib/types";

interface Props {
  onSelect: (result: SearchResult) => void;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const DEBOUNCE_MS = 350;

export default function SearchBar({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: query,
          format: "jsonv2",
          addressdetails: "0",
          limit: "6",
        });
        const res = await fetch(`${NOMINATIM_URL}?${params}`, {
          signal: ctrl.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Nominatim ${res.status}`);
        const json = (await res.json()) as RawNominatimResult[];
        setResults(json.map(toResult));
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[search]", err);
        }
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="relative">
      <input
        className="w-full rounded-md bg-slate-900/80 border border-slate-700 px-3 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
        placeholder="Search a ski mountain or place&hellip;"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {loading && (
        <span className="absolute right-3 top-2.5 text-xs text-slate-500">
          searching&hellip;
        </span>
      )}
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-md border border-slate-700 bg-slate-900 shadow-xl">
          {results.map((r) => (
            <li key={r.placeId}>
              <button
                type="button"
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-800"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(r);
                  setQuery(r.displayName.split(",")[0]);
                  setOpen(false);
                }}
              >
                <div className="font-medium">{r.displayName.split(",")[0]}</div>
                <div className="text-xs text-slate-400 truncate">
                  {r.displayName}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RawNominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
  type?: string;
  category?: string;
}

function toResult(r: RawNominatimResult): SearchResult {
  const south = parseFloat(r.boundingbox[0]);
  const north = parseFloat(r.boundingbox[1]);
  const west = parseFloat(r.boundingbox[2]);
  const east = parseFloat(r.boundingbox[3]);
  const bbox: Bbox = [west, south, east, north];
  return {
    placeId: r.place_id,
    displayName: r.display_name,
    bbox,
    center: [parseFloat(r.lon), parseFloat(r.lat)],
    type: r.type,
    category: r.category,
  };
}
