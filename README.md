# Open Ski Model

A web-based PWA (Next.js, deployed on Vercel) that generates 3D-printable
topographic models of ski mountains. Type a mountain, frame a bounding
box, get a watertight `.stl` you can hand to your slicer.

> **Status: Phase 3 / 3 — feature-complete.** Map picker, server-side
> elevation pipeline (AWS terrarium + USGS 3DEP), Babylon viewer with
> hillshade and contours, STL export in millimeters, share-by-URL,
> installable PWA.

## Features

- **Pick any mountain on Earth.** Search via OpenStreetMap's Nominatim,
  refine with a draggable / resizable bounding box on a MapTiler outdoor
  basemap. No Mapbox token needed.
- **Open elevation data, no API keys.**
  - AWS Open Data **terrain tiles** (terrarium PNG encoding) — global,
    blended from SRTM / NED / ETOPO / GMTED, 30 m where the source
    permits.
  - **USGS 3DEP** auto-selected when the bbox is fully inside the US —
    typically 10 m, sometimes 1 m.
- **Watertight mesh.** Top surface + four side walls + bottom face, all
  oriented with consistent outward normals. Safe for any 3D-printing
  slicer.
- **3D preview** (Babylon.js) with orbit camera, hypsometric coloring
  (forest → scrub → rock → snow), sun-angle hillshade, and toggleable
  marching-squares contour lines.
- **STL export** in millimeters — pop it into Cura / PrusaSlicer / Bambu
  Studio and it'll already be the right physical size.
- **Share-by-URL.** Every change to the bbox / size / exaggeration is
  mirrored to the URL, so a deep link reopens the same model.
- **Installable PWA.** Manifest + service worker (Serwist). App shell and
  static assets cache; map tiles cached opportunistically.

## Run locally

```bash
cp .env.local.example .env.local
# add NEXT_PUBLIC_MAPTILER_KEY (free at https://www.maptiler.com/cloud/)
npm install
npm run dev
```

Open <http://localhost:3000>.

## Deploy

```bash
npx vercel
```

Set `NEXT_PUBLIC_MAPTILER_KEY` in Vercel project env vars. No other
configuration required. The `/api/elevation` route runs on Vercel's Node
runtime and uses up to 30s per request (default Hobby limit is 10s — set
`maxDuration` higher on Pro or stay within the default for typical bboxes).

## How elevation works

The Earth is mapped onto a giant pixel canvas at each Web Mercator zoom
level — at zoom `z` it's `2^z` tiles wide, each 256×256 px. Each pixel of
a terrarium tile encodes elevation in its RGB channels:

```
elevation_m = R * 256 + G + B / 256 - 32768
```

`POST /api/elevation { bbox, gridSize, source? }`:

1. Pick the lowest Web Mercator zoom where one source pixel ≤ one output
   cell at the bbox's latitude.
2. Compute which tiles cover the bbox.
3. Fetch them in parallel from `s3://elevation-tiles-prod/` (public, no
   auth).
4. Decode the PNGs (pngjs) and bilinearly sample to a `gridSize×gridSize`
   float grid in row-major order, north-to-south.
5. Return `{ heights, width, height, min, max, source, zoom }`.

For US bboxes, `source: "auto"` instead hits USGS 3DEP's `exportImage`
REST endpoint and parses the returned Float32 GeoTIFF via the `geotiff`
package — single round trip, no tile stitching.

## How the mesh is built

Imagine the height grid as a tablecloth draped over a square table.
Phase 2 rendered just the cloth. Phase 3 also sews the cloth to the table
edges (four side walls) and adds the table top (a single flat bottom
quad). The result is *watertight* — every triangle edge is shared by
exactly two triangles, normals point outward, the volume is well-defined.

Scene units are inches. Vertical scale is
`elevation_m × (print_width_in / bbox_width_m) × verticalExaggeration`,
so a 1× exaggeration is true-scale, and the default 2× makes a 6" print
feel like terrain.

For STL export we clone the mesh, scale by 25.4 (mm/in), and let the
serializer bake the transform into vertex positions. The downloaded file
opens at life-size in any slicer that defaults to millimeters.

## URL state

```
/?b=W,S,E,N&s=WxH&t=baseInches&v=exag&label=Name
```

Example:

```
/?b=-72.50000,44.92000,-72.46000,44.94000&s=6x6&t=0.25&v=2&label=Jay%20Peak
```

The page reads this on mount and rebuilds the picker / model spec.

## Project layout

```
app/
  api/elevation/route.ts   POST handler (dispatch terrarium / USGS)
  layout.tsx               Root + RegisterSW + metadata
  page.tsx                 Map ↔ viewer state machine
  sw.ts                    Service worker entry (built by Serwist)
components/
  MapPicker.tsx            MapLibre + draggable bbox
  ModelViewer.tsx          Babylon scene + toolbar (sun, contours, STL)
  SearchBar.tsx            Nominatim geocoding
  SizeControls.tsx         Print-size + exaggeration inputs
  RegisterSW.tsx           Service-worker registration
lib/
  bbox.ts                  Bbox math (small-angle approx)
  elevation/
    terrarium.ts           Tile math + PNG decoding (server)
    usgs.ts                3DEP exportImage + GeoTIFF parsing (server)
    types.ts               Request/response types
  mesh/
    watertight.ts          Build closed VertexData from height grid
    contours.ts            Marching squares contour lines
  types.ts                 Shared geometry types
  url-state.ts             Encode/decode bbox+size to search params
public/
  manifest.json
  icon.svg
```

## License

MIT.
