// The second line of the name plate: the town a resort is in and its state
// or country, as in "Jay, VT" or "Zermatt, Switzerland".
//
// The ski-area index carries a town for about four resorts in ten, and it is
// often a hamlet or the next town over. So the town is looked up at the
// resort's base area, which is where its address is, and not at the middle
// of the mountain.

import type { ResortData } from "@/lib/resort/types";
import type { LngLat } from "@/lib/types";

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
/** Nominatim's detail level for a village or suburb; towns and cities come with it. */
const REVERSE_ZOOM = "13";
const METERS_PER_DEG_LAT = 111_320;
/** How near a run must start or end to count toward a lift station. */
const STATION_REACH_M = 150;
/** The longest second line the plate's field and a share link will carry. */
export const PLACE_MAX_CHARS = 60;

/** States and provinces are abbreviated; every other region is spelled out. */
const REGION_CODES = new Map(Object.entries({
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL",
  Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  Alberta: "AB", "British Columbia": "BC", Manitoba: "MB", "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL", "Northwest Territories": "NT", "Nova Scotia": "NS",
  Nunavut: "NU", Ontario: "ON", "Prince Edward Island": "PE", Quebec: "QC",
  Saskatchewan: "SK", Yukon: "YT",
}));

const ABBREVIATING_COUNTRIES = new Set(["US", "CA"]);

export interface PlaceParts {
  town: string | null;
  region: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
}

/** The plate's second line: "Jay, VT", "Whistler, BC", "Zermatt, Switzerland". */
export function placeLine(parts: PlaceParts): string {
  const { town, region, country, countryCode } = parts;
  if (countryCode && ABBREVIATING_COUNTRIES.has(countryCode)) {
    // Without a town the state stands alone, and reads better spelled out.
    const state = town && region ? (REGION_CODES.get(region) ?? region) : region;
    return [town, state].filter(Boolean).join(", ");
  }
  return [town ?? region, country].filter(Boolean).join(", ");
}

/** The index's "Locality, Region, Country", which leaves the locality off when it has none. */
export function placeFromIndex(location: string | null, countryCode: string | null): PlaceParts {
  const names = (location ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const country = names.pop() ?? null;
  const region = names.pop() ?? null;
  const town = names.pop() ?? null;
  return { town, region, country, countryCode: countryCode?.toUpperCase() ?? null };
}

const ADDRESS_FIELDS = [
  "city",
  "town",
  "village",
  "municipality",
  "state",
  "province",
  "country",
  "country_code",
] as const;

/** The address object of a Nominatim reverse lookup. */
export type NominatimAddress = Partial<Record<(typeof ADDRESS_FIELDS)[number], string>>;

/** The address in a reverse lookup's reply, keeping only the fields that are text. */
function addressIn(body: unknown): NominatimAddress | null {
  if (typeof body !== "object" || body === null || !("address" in body)) return null;
  const raw = body.address;
  if (typeof raw !== "object" || raw === null) return null;
  const fields: Record<string, unknown> = { ...raw };
  const address: NominatimAddress = {};
  for (const field of ADDRESS_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && value.trim()) address[field] = value.trim();
  }
  return address;
}

/** Hamlets and neighborhoods are passed over: the plate wants the town they belong to. */
export function placeFromNominatim(address: NominatimAddress): PlaceParts {
  return {
    town: address.city ?? address.town ?? address.village ?? address.municipality ?? null,
    region: address.state ?? address.province ?? null,
    country: address.country ?? null,
    countryCode: address.country_code?.toUpperCase() ?? null,
  };
}

/** Ask Nominatim which town a point is in. Null when it has no answer. */
export async function lookupPlace(point: LngLat, signal?: AbortSignal): Promise<PlaceParts | null> {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: point[1].toFixed(5),
    lon: point[0].toFixed(5),
    zoom: REVERSE_ZOOM,
    addressdetails: "1",
    "accept-language": "en",
  });
  const res = await fetch(`${REVERSE_URL}?${params}`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nominatim reverse lookup failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const address = addressIn(body);
  return address ? placeFromNominatim(address) : null;
}

function metersBetween(a: LngLat, b: LngLat): number {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * metersPerDegLng, (a[1] - b[1]) * METERS_PER_DEG_LAT);
}

/**
 * The resort's main base: the lift station the most runs finish at. Runs
 * are drawn downhill, so a bottom station gathers run ends and a top
 * station run starts; elevation isn't needed to tell them apart. Only
 * lines tagged to the ski area count, so data loaded for somewhere else
 * gives null instead of a guess.
 */
export function resortBasePoint(resort: ResortData, areaId: string): LngLat | null {
  const tagged = (line: { areas?: string[]; coords: LngLat[] }) =>
    line.coords.length >= 2 && (line.areas?.includes(areaId) ?? false);
  const runs = resort.runs.filter((run) => !run.isArea && tagged(run));
  if (runs.length === 0) return null;
  const starts = runs.map((run) => run.coords[0]);
  const ends = runs.map((run) => run.coords[run.coords.length - 1]);
  const near = (points: LngLat[], station: LngLat) =>
    points.filter((point) => metersBetween(point, station) <= STATION_REACH_M).length;

  let base: LngLat | null = null;
  let most = 0;
  for (const lift of resort.lifts.filter(tagged)) {
    for (const station of [lift.coords[0], lift.coords[lift.coords.length - 1]]) {
      const arrivals = near(ends, station) - near(starts, station);
      if (arrivals > most) {
        most = arrivals;
        base = station;
      }
    }
  }
  if (base) return base;

  // No lift gathers runs: take the run end nearest where they finish on
  // average. The average itself can fall between two base areas.
  const mean: LngLat = [
    ends.reduce((sum, end) => sum + end[0], 0) / ends.length,
    ends.reduce((sum, end) => sum + end[1], 0) / ends.length,
  ];
  return ends.reduce((nearest, end) => (metersBetween(end, mean) < metersBetween(nearest, mean) ? end : nearest));
}
