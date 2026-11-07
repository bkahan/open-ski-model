# Roadmap

## Done

- Phases 1–3: map picker, server-side elevation (terrarium + USGS 3DEP),
  watertight mesh, shapes, plinth + CSG engravings, STL / STEP export,
  share-by-URL, PWA.

## Multicolor resort models

Goal: type a resort name, get a print-ready multicolor model with runs
colored by difficulty and lifts as stripes.

### Phase R1 — resort data + overlay (done)

- Data: OpenSkiData's daily GeoJSON, reduced by `scripts/build-ski-data.mjs`
  (weekly GitHub Action) to 1° cells + a ski-area index on the `data`
  branch, read through jsDelivr. Replaced live Overpass queries, which the
  public instances rejected under load ("all query workers are busy").
- `POST /api/resort` assembles runs and lifts for a bbox from the cells;
  `GET /api/resort/search` ranks ski areas by name.
- Runs drawn on the 2D map and draped on the 3D terrain as ribbons, one
  mesh per color. Lifts toggleable. Minimum run width (default 1.2 mm)
  widens anything narrower.
- Color scheme auto-picked by hemisphere (N. America green/blue/black,
  Europe blue/red/black), overridable.
- Picking a ski resort in search turns and fits the frame to the resort's
  natural viewport (OpenSkiData's `viewportHint`); picking a place frames
  around whatever runs are nearby.
- Settings mirrored in the URL (`runs`, `lf`, `mw`, `cs`).

### Engraving rework (in progress)

Babylon's BSP CSG took ~100 s and 3 GB to cut the brand into a 256-grid
terrain, which crashes phones, and the plinth was a 9 mm bevel sliver with
no visible text. Replacing both:

- E1 (done): Manifold (WASM) boolean engine; rectangle terrain made truly
  manifold (bottom fan over the wall ring); bottom brand cut with Manifold.
- E2: chamfered plinth rim (15 mm south, 6 mm elsewhere, 35°), label +
  compass as pockets via Manifold, font sized from the chamfer slope and
  shrunk to fit, with a 3 mm cap-height floor. Pocket fill bodies emitted
  as color groups for multicolor.
- E3: STL/STEP export from the Manifold union (terrain + plinth) instead of
  Babylon CSG; remove the Babylon CSG path and raised-text fallback.

### Phase R2 — inlay bodies

- Turn each color group into a solid: ribbon extruded ~0.8 mm down into
  the terrain, CSG-subtracted from the base, flush top.
- Color budget: merge groups to fit the slots available (4-slot AMS:
  white base + 3 colors).
- Lift terminals as small bumps.

### Phase R3 — multicolor export

- Bambu Studio / Orca 3MF with one object per body and filament
  assignments in `model_settings.config`.
- Zip of per-color STLs for other slicers.

### Phase R4 — extras

- Forest areas (`landuse=forest` / `natural=wood`) as a fifth color.
- Elevation snowline for single-extruder printers (one filament swap).
- Double-black / terrain-park markers.
- Serwist migration to Turbopack (removes `--webpack`).

## Known limitations

- The data refreshes weekly (Sunday 06:17 UTC); a run added to OSM takes
  up to a week plus OpenSkiData's daily build to appear.
- Runs mapped as polygons (`area:piste=yes`) are drawn by their outline.
- Trail colors can clash with the hypsometric terrain palette in the
  viewer (green on green); the print base will be white.
