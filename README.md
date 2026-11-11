# Open Ski Model

A web-based PWA (Next.js, deployed on Vercel) that generates 3D-printable
topographic models of ski mountains. Type a mountain, frame a bounding
box, get a watertight `.stl` you can hand to your slicer.

![Hero — map picker beside the 3D viewer](docs/images/hero.png)

> **Status: feature-complete.** Map picker, server-side elevation pipeline
> (AWS terrarium + USGS 3DEP), Babylon viewer with hillshade and
> contours, multiple footprint shapes, optional engraved plinth + compass
> + brand mark, STL export in millimeters, share-by-URL, installable PWA.

## Features

- **Pick any mountain on Earth.** Search via OpenStreetMap's Nominatim,
  refine with a draggable / resizable bounding box on a MapTiler outdoor
  basemap. No Mapbox token needed.

  ![Map picker with draggable bbox](docs/images/map-picker.png)

- **Open elevation data, no API keys.**
  - AWS Open Data **terrain tiles** (terrarium PNG encoding) — global,
    blended from SRTM / NED / ETOPO / GMTED, 30 m where the source
    permits.
  - **USGS 3DEP** auto-selected when the bbox is fully inside the US —
    typically 10 m, sometimes 1 m.
- **Pick a footprint shape.** Rectangle, circle, or hexagon — the
  non-rectangular shapes are inscribed in the bbox, with the canvas
  aspect locked so the inscribed figure fills the frame. Circle and
  hexagon can be rotated; drag a corner handle to spin.

  ![Shape options: rectangle / circle / hexagon](docs/images/shapes.png)

- **Watertight mesh, boolean-engraved.** Top surface + side walls + bottom
  face, all oriented with consistent outward normals and free of
  T-junctions, so the solid is manifold. All booleans run in
  [Manifold](https://github.com/elalish/manifold) (WASM), which handles a
  130k-triangle terrain in well under a second: the brand on the
  underside, the name plate and compass rose in the plinth's chamfer, and
  the terrain + plinth union used for export.

- **Chamfered plinth with name plate.** A 15 mm rim at 35° all round. The
  place name and a compass rose are cut glyph by glyph into the chamfer
  on the resort's base side (the mean downhill direction of its runs
  and lifts; the frame's bottom edge when there is no resort), so on a
  circular plinth they follow the cone. Cap height comes
  from the chamfer slope and shrinks (then shortens with "…") to fit the
  face, never below 6 mm. Plate text is laid out for a 0.4 mm nozzle:
  strokes thickened to 0.8 mm, letters spaced so at least 0.5 mm of
  plate is left between any two of them. The pocket fill bodies are kept as
  separate inlays for multicolor printing.
- **Optional plinth + engravings.**
  - *Label + compass:* a beveled plinth wraps the model and the place
    name + an N/E/S/W compass rose are inlaid into the rim on the base
    side, tilted 35° so they face up on a desk. A second, smaller line
    under the name takes the town and state in capitals ("JAY, VT"), with the rose
    beside the pair. Picking a resort fills it in: from the ski-area index
    at once, then from an OpenStreetMap (Nominatim) lookup at the resort's
    base area. Edit it, or clear it for one line.
  - *Brand on bottom:* `craftedcarving.com` engraved into the bottom
    face. Independent toggle.

  ![Inlaid plinth label + compass and brand on bottom](docs/images/engravings.png)

- **Adjustable mesh density.** Normal (256), High (512), or a Custom
  slider up to 1024. File size scales ~N²; the UI warns past 512.
- **3D preview** (Babylon.js) with orbit camera, hypsometric coloring
  (forest → scrub → rock → snow), sun-angle hillshade, and toggleable
  marching-squares contour lines.

  ![Babylon viewer with hillshade + contours](docs/images/viewer.png)

- **STL export** in millimeters — pop it into Cura / PrusaSlicer / Bambu
  Studio and it'll already be the right physical size.

  ![Exported STL loaded in a slicer](docs/images/slicer.png)

- **STEP export** for CAD. Unlike STL (triangle soup), STEP is a true
  B-rep solid (AP203 / CONFIG_CONTROL_DESIGN): every triangle becomes an
  `ADVANCED_FACE`, vertices and edges are deduped, and the whole model
  is wrapped as a single `MANIFOLD_SOLID_BREP`. Fusion / SolidWorks /
  FreeCAD open it as one selectable object. Units are declared as mm.

- **Ski runs and lifts.** Downhill runs and lifts come from
  [OpenSkiData](https://openskidata.org) (OpenSkiMap's processed OSM
  data), rebuilt weekly by a GitHub Action into 1° cells on the `data`
  branch and served through jsDelivr, so no query server sits in the
  request path. They're drawn on the map and set into the 3D terrain,
  colored by difficulty. The search box lists ski resorts from the same
  dataset; picking one turns and fits the frame to the resort's natural
  viewport. Trail colors follow the convention the data was tagged under
  (North America green / blue / black, Europe and Japan blue / red /
  black) or can be set by hand. Lifts are a toggle; runs narrower than
  the adjustable minimum width (1.2 mm) are widened so they print.
  Multicolor inlay bodies and 3MF export are next — see
  `docs/roadmap.md`.

- **Share-by-URL.** Every change to the bbox / shape / rotation / size /
  density / engraving toggles / model height / run settings is mirrored
  to the URL, so a deep link reopens the same model.
- **Installable PWA.** Manifest + service worker (Serwist). App shell and
  static assets cache; map tiles cached opportunistically.

## Run locally

```bash
# Create .env.local with your MapTiler key (free at https://www.maptiler.com/cloud/)
echo 'NEXT_PUBLIC_MAPTILER_KEY=your_key_here' > .env.local
npm install   # also copies manifold-3d's WASM into public/manifold.wasm
npm run dev
npm test      # unit tests (Vitest)
```

Ski-run data is read from the `data` branch via jsDelivr by default. To
work against a local build of it, run
`node scripts/build-ski-data.mjs out` (downloads ~1 GB from OpenSkiData;
one download per day is their limit), serve `out/` with any static
server, and set `SKI_DATA_BASE` to its URL in `.env.local`.

Open <http://localhost:3000>.

> `npm run dev` and `npm run build` pass `--webpack` because Next 16
> defaults to Turbopack and the current `@serwist/next` plugin still
> injects a Webpack config. A Turbopack-compatible Serwist migration is
> a separate piece of work.

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

Imagine the height grid as a tablecloth draped over a square table. The
mesh builder sews the cloth to the table edges (side walls) and adds the
table top (a single flat bottom quad). The result is *watertight* —
every triangle edge is shared by exactly two triangles, normals point
outward, the volume is well-defined.

For non-rectangular shapes the grid is masked to the inscribed circle or
hexagon and the side walls follow the shape's perimeter (with optional
rotation). The rectangle's bottom face is a fan over the wall perimeter
ring (not a single quad), so every base edge is shared by exactly two
triangles. The brand mark is cut with a Manifold boolean difference
against extruded glyph outlines (`lib/mesh/manifold.ts`,
`lib/mesh/text.ts`), so the model stays watertight after the subtraction.

Scene units are inches. Vertical scale is
`elevation_m × (print_width_in / bbox_width_m) × verticalExaggeration`,
so a 1× exaggeration is true-scale. The exaggeration comes from the
model height setting (0.75" by default): each resort's relief is scaled
to that height on the print, within 0.5–8×.

For STL export we clone the mesh, scale by 25.4 (mm/in), and let the
serializer bake the transform into vertex positions. The downloaded file
opens at life-size in any slicer that defaults to millimeters.

For STEP export (`lib/mesh/step-export.ts`) we walk the same final mesh,
dedupe vertices by exact position, dedupe undirected edges, emit one
`ADVANCED_FACE` per triangle, and wrap everything in a single
`MANIFOLD_SOLID_BREP`. When a plinth is present the terrain + plinth are
CSG-unioned first (same path as STL); raised-fallback engraving meshes
are fused in by position dedup so the export stays a single solid.

## URL state

```
/?b=W,S,E,N&sh=shape&r=rot&s=WxH&lk=1&g=grid&el=1&eb=0&t=baseInches&v=exag&label=Name&place=Town
```

| Key     | Meaning                                                |
| ------- | ------------------------------------------------------ |
| `b`     | bbox: `west,south,east,north`                          |
| `sh`    | `rectangle` \| `circle` \| `hexagon`                   |
| `r`     | rotation in degrees (omitted when 0)                   |
| `s`     | print canvas size: `WxH` in inches                     |
| `lk`    | `1` if aspect is locked (omitted otherwise)            |
| `g`     | grid size (omitted at the default 256)                 |
| `el`    | `1` to engrave the plinth label + compass              |
| `eb`    | `0` to disable the bottom brand engraving (on by default) |
| `t`     | base thickness, inches                                 |
| `rh`    | model height, base to peak, in inches                  |
| `ol`    | `1` to cut the model to the resort's outline           |
| `ra`    | ski area id, keeps neighbors out of the outline        |
| `runs`  | `0` to hide ski runs (on by default)                   |
| `lf`    | `0` to hide lifts (on by default)                      |
| `mw`    | minimum run width in mm (omitted at the default 1.2)   |
| `cs`    | trail color scheme `na` \| `eu` (omitted when auto)    |
| `label` | display name (URL-encoded)                             |
| `place` | second line of the name plate, e.g. `Jay, VT` (omitted when empty) |

Example:

```
/?b=-72.50000,44.92000,-72.46000,44.94000&s=6x6&t=0.25&v=2&label=Jay%20Peak
```

The page reads this on mount and rebuilds the picker / model spec.

## Project layout

```
app/
  api/elevation/route.ts   POST handler (dispatch terrarium / USGS)
  api/resort/route.ts      POST handler (runs + lifts from the data cells)
  api/resort/search/       GET handler (ski-area name search)
  layout.tsx               Root + RegisterSW + metadata
  not-found.tsx            404 page (required by Next 16 at build time)
  page.tsx                 Map ↔ viewer state machine
  sw.ts                    Service worker entry (built by Serwist)
components/
  MapPicker.tsx            MapLibre + draggable bbox
  ModelViewer.tsx          Babylon scene + toolbar (sun, contours, STL)
  SearchBar.tsx            Nominatim geocoding
  ShapeControls.tsx        Rectangle / circle / hexagon selector
  SizeControls.tsx         Print-size + model-height inputs
  DensityControls.tsx      Mesh-density preset + custom slider
  EngravingControls.tsx    Label/compass + brand toggles
  ResortControls.tsx       Runs / lifts / min width / color scheme
  RegisterSW.tsx           Service-worker registration
lib/
  bbox.ts                  Bbox math (small-angle approx)
  shape.ts                 Shape geometry + point-in-shape tests
  elevation/
    terrarium.ts           Tile math + PNG decoding (server)
    usgs.ts                3DEP exportImage + GeoTIFF parsing (server)
    types.ts               Request/response types
  resort/
    skidata.ts             Data-branch cell reader + ski-area search (server)
    request.ts             /api/resort request validation
    place.ts               Town + state for the name plate's second line
    colors.ts              Difficulty → color per scheme
    geojson.ts             Resort data → GeoJSON for the map
    settings.ts            Run settings defaults + limits
    types.ts               Run / lift / response types
scripts/
  build-ski-data.mjs       OpenSkiData → cells + index (run by the Action)
  copy-manifold-wasm.mjs   Copies manifold.wasm into public/
lib/mesh/
    manifold.ts            Manifold (WASM) loader + mesh conversions
    engrave.ts             Plinth + name plate + brand + export union
    plinth.ts              Chamfered plinth solid (hull of offset outlines)
    nameplate.ts           Glyph placement on the chamfer, font fitting
    printable.ts           Stroke thickening and letter spacing for a 0.4 mm nozzle
    compass.ts             Compass rose outlines
    silhouette.ts          Resort outline, slab and name tab
    inlays.ts              Runs + lifts as flush color bodies, one per filament
    text.ts                Font loading, glyph outlines, text solids
    watertight.ts          Build closed VertexData from height grid
    runs.ts                Runs + lifts on the model plane, grouped by color
    contours.ts            Marching squares contour lines
    plinth.ts              Beveled plinth around the model
    compass.ts             North-arrow indicator geometry
    text.ts                Glyph extrusion for engraved text
    step-export.ts         AP203 STEP (B-rep solid) serializer
  types.ts                 Shared geometry types
  url-state.ts             Encode/decode model spec to search params
public/
  manifest.json
  icon.svg
  fonts/
docs/
  images/                  Screenshots / placeholder art for this README
```

## License

MIT.
