// What the hiking dataset keeps from OpenStreetMap, and in what shape.
// Pure functions over the GeoJSON features written by
// scripts/extract-hike-features.py; scripts/build-hike-data.mjs does the IO.

export const CELL_DEG = 1;
// 1e-5° is about 1.1 m, well under anything a print can show.
const PRECISION = 1e5;
const METERS_PER_DEG_LAT = 111_320;

/** Ponds smaller than this never reach a printable size. */
export const MIN_WATER_SQUARE_METERS = 1000;
/** Named trails shorter than this stay out of the search index. */
export const MIN_INDEXED_TRAIL_KM = 0.5;
/** Same-name ways this close (in degrees, about 500 m) are one trail. */
const SAME_TRAIL_REACH_DEG = 0.005;

const NO_ENTRY = new Set(["no", "private", "discouraged"]);
const PAVED = new Set([
  "asphalt",
  "brick",
  "cobblestone",
  "concrete",
  "concrete:lanes",
  "concrete:plates",
  "paved",
  "paving_stones",
  "sett",
]);
const FEET_TO_METERS = 0.3048;
// Mapped as natural=water, but a riverbank is not a lake.
const FLOWING_WATER = new Set(["river", "stream", "canal", "ditch", "drain"]);
const HUTS = new Set(["alpine_hut", "wilderness_hut"]);

function round(v) {
  return Math.round(v * PRECISION) / PRECISION;
}

/** Round, and drop consecutive repeats. */
export function cleanLine(coords) {
  const out = [];
  for (const c of coords) {
    const p = [round(c[0]), round(c[1])];
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

export function bboxOf(lines) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

function centerOf([w, s, e, n]) {
  return [round((w + e) / 2), round((s + n) / 2)];
}

export function cellsTouching([w, s, e, n]) {
  const keys = [];
  for (let lat = Math.floor(s / CELL_DEG); lat <= Math.floor(n / CELL_DEG); lat++) {
    for (let lng = Math.floor(w / CELL_DEG); lng <= Math.floor(e / CELL_DEG); lng++) {
      keys.push(`${lat}/${lng}`);
    }
  }
  return keys;
}

function metersPerDegLng(lat) {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function lineLengthKm(line) {
  let meters = 0;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const dx = (x1 - x0) * metersPerDegLng((y0 + y1) / 2);
    const dy = (y1 - y0) * METERS_PER_DEG_LAT;
    meters += Math.hypot(dx, dy);
  }
  return meters / 1000;
}

export function ringSquareMeters(ring) {
  if (ring.length < 4) return 0;
  const mPerDegLng = metersPerDegLng(ring[0][1]);
  let twice = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x0, y0] = ring[i - 1];
    const [x1, y1] = ring[i];
    twice += x0 * y1 - x1 * y0;
  }
  return (Math.abs(twice) / 2) * mPerDegLng * METERS_PER_DEG_LAT;
}

function onFootAllowed(tags) {
  // foot=* speaks for walkers and outranks the general access=*.
  return !NO_ENTRY.has(tags.foot ?? tags.access);
}

/**
 * Whether a path or footway is a hiking trail. A highway=path counts when
 * it is open to walkers, not paved and not a sidewalk or crossing.
 * highway=footway is mostly sidewalks and park paths, so one must also
 * carry a name or a hiking tag.
 */
export function isHikingTrail(tags) {
  if (!onFootAllowed(tags) || PAVED.has(tags.surface) || tags.footway) return false;
  if (tags.highway === "path") return true;
  if (tags.highway !== "footway") return false;
  return Boolean(tags.name || tags.sac_scale || tags.trail_visibility);
}

/** The cell record for a trail, or null when the feature is not one. */
export function trailFrom(feature) {
  const tags = feature.properties;
  if (feature.geometry.type !== "LineString" || !isHikingTrail(tags)) return null;
  const line = cleanLine(feature.geometry.coordinates);
  if (line.length < 2) return null;
  return {
    id: feature.id,
    n: tags.name ?? null,
    ...(tags.informal === "yes" ? { i: 1 } : {}),
    g: line,
  };
}

function poiKind(tags) {
  if (tags.natural === "peak") return "peak";
  if (HUTS.has(tags.tourism)) return "hut";
  if (tags.highway === "trailhead") return "trailhead";
  return null;
}

/**
 * Meters, or null for anything that is not a plausible elevation. ele=*
 * is meters unless it says feet, which some US peaks do.
 */
export function parseElevation(raw) {
  const match = typeof raw === "string" ? /^(-?\d+(?:\.\d+)?) ?(m|ft|')?$/.exec(raw.trim()) : null;
  if (!match) return null;
  const inFeet = match[2] === "ft" || match[2] === "'";
  const meters = Number.parseFloat(match[1]) * (inFeet ? FEET_TO_METERS : 1);
  return meters > -500 && meters < 9000 ? Math.round(meters) : null;
}

function pointOf(geometry) {
  if (geometry.type === "Point") return [round(geometry.coordinates[0]), round(geometry.coordinates[1])];
  // A hut or trailhead drawn as an outline: its middle is close enough.
  if (geometry.type === "MultiPolygon") return centerOf(bboxOf([geometry.coordinates[0][0]]));
  return null;
}

/**
 * The cell record for a peak, hut or trailhead. Peaks need a name; an
 * unnamed bump is not a summit anyone is looking for.
 */
export function poiFrom(feature) {
  const tags = feature.properties;
  const kind = poiKind(tags);
  if (!kind || (kind === "peak" && !tags.name)) return null;
  const at = pointOf(feature.geometry);
  if (!at) return null;
  const elevation = kind === "peak" ? parseElevation(tags.ele) : null;
  return {
    id: feature.id,
    k: kind,
    n: tags.name ?? null,
    ...(elevation === null ? {} : { e: elevation }),
    c: at,
  };
}

/** The cell record for a lake or pond: polygons as [outer, ...holes]. */
export function waterFrom(feature) {
  const tags = feature.properties;
  if (tags.natural !== "water" || FLOWING_WATER.has(tags.water)) return null;
  if (feature.geometry.type !== "MultiPolygon") return null;
  const polygons = [];
  let squareMeters = 0;
  for (const polygon of feature.geometry.coordinates) {
    const [outer, ...inner] = polygon.map(cleanLine);
    if (!outer || outer.length < 4) continue;
    const holes = inner.filter((ring) => ring.length >= 4);
    squareMeters += ringSquareMeters(outer) - holes.reduce((sum, hole) => sum + ringSquareMeters(hole), 0);
    polygons.push([outer, ...holes]);
  }
  if (polygons.length === 0 || squareMeters < MIN_WATER_SQUARE_METERS) return null;
  return { id: feature.id, n: tags.name ?? null, p: polygons };
}

/** The search-index entry for a mountain range. */
export function rangeFrom(feature) {
  const tags = feature.properties;
  if (tags.natural !== "mountain_range" || !tags.name) return null;
  const { type, coordinates } = feature.geometry;
  const base = { id: feature.id, n: tags.name, k: "range", r: tags.region };
  if (type === "Point") return { ...base, c: [round(coordinates[0]), round(coordinates[1])] };
  const lines = type === "LineString" ? [coordinates] : type === "MultiPolygon" ? coordinates.map((p) => p[0]) : null;
  if (!lines) return null;
  const bbox = bboxOf(lines).map(round);
  return { ...base, c: centerOf(bbox), b: bbox };
}

function reaches(a, b) {
  return (
    a[0] - SAME_TRAIL_REACH_DEG <= b[2] &&
    a[2] + SAME_TRAIL_REACH_DEG >= b[0] &&
    a[1] - SAME_TRAIL_REACH_DEG <= b[3] &&
    a[3] + SAME_TRAIL_REACH_DEG >= b[1]
  );
}

/**
 * Search-index entries for named trails. A trail is drawn as many ways;
 * ways that share a name and sit within reach of each other are one
 * entry, so the two "Loop Trail"s a state apart stay two.
 * `trails` are cell records with their region: { id, n, g, r }.
 */
export function namedTrails(trails) {
  const byName = new Map();
  for (const trail of trails) {
    if (!trail.n) continue;
    const group = byName.get(trail.n) ?? [];
    group.push({ trail, bbox: bboxOf([trail.g]) });
    byName.set(trail.n, group);
  }

  const entries = [];
  for (const [name, ways] of byName) {
    const cluster = ways.map((_, i) => i);
    const find = (i) => {
      while (cluster[i] !== i) i = cluster[i] = cluster[cluster[i]];
      return i;
    };
    for (let i = 0; i < ways.length; i++) {
      for (let j = i + 1; j < ways.length; j++) {
        if (reaches(ways[i].bbox, ways[j].bbox)) cluster[find(j)] = find(i);
      }
    }
    const grouped = new Map();
    ways.forEach((way, i) => {
      const root = find(i);
      const members = grouped.get(root) ?? [];
      members.push(way.trail);
      grouped.set(root, members);
    });
    for (const members of grouped.values()) {
      const km = members.reduce((sum, t) => sum + lineLengthKm(t.g), 0);
      if (km < MIN_INDEXED_TRAIL_KM) continue;
      members.sort((a, b) => (a.id < b.id ? -1 : 1));
      const bbox = bboxOf(members.map((t) => t.g)).map(round);
      entries.push({
        id: `t${members[0].id}`,
        n: name,
        k: "trail",
        r: members[0].r,
        c: centerOf(bbox),
        b: bbox,
        km: Math.round(km * 10) / 10,
      });
    }
  }
  return entries;
}

/** The search-index entry for a named peak or hut; trailheads are not searched for. */
export function poiPlace(poi, region) {
  if (!poi.n || poi.k === "trailhead") return null;
  return { id: poi.id, n: poi.n, k: poi.k, r: region, c: poi.c, ...(poi.e === undefined ? {} : { e: poi.e }) };
}

const KIND_ORDER = { range: 0, peak: 1, trail: 2, hut: 3 };

/**
 * Index order is the tie-break within a search tier: ranges, then peaks
 * from the highest down, then trails from the longest down, then huts.
 */
export function comparePlaces(a, b) {
  return (
    KIND_ORDER[a.k] - KIND_ORDER[b.k] ||
    (b.e ?? 0) - (a.e ?? 0) ||
    (b.km ?? 0) - (a.km ?? 0) ||
    a.n.localeCompare(b.n) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
