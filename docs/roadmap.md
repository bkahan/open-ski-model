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

### Engraving rework (done)

Babylon's BSP CSG took ~100 s and 3 GB to cut the brand into a 256-grid
terrain, which crashes phones, and the plinth was a 9 mm bevel sliver with
no visible text. Replacing both:

- E1 (done): Manifold (WASM) boolean engine; rectangle terrain made truly
  manifold (bottom fan over the wall ring); bottom brand cut with Manifold.
- E2 (done): chamfered plinth, 15 mm rim at 35° all round (a single
  chamfer angle ties rim width to height, so 10.5 mm tall). Name and
  compass rose (star plus N/E/S/W, north true) cut into the chamfer on
  the resort's base side (mean
  downhill direction of runs and lifts, snapped to a face on rectangles
  and hexagons; frame bottom without a resort) with Manifold, glyph by
  glyph so they follow a circular plinth's cone. Cap height is 38% of the
  chamfer slope (3–9 mm), shrunk to fit. A name that still won't fit at
  3 mm drops what follows a comma, then a trailing "Resort" / "Ski Area",
  and only then is cut with "…". Hexagon sides are too short to share, so
  the rose gets the next face.
  Fill bodies for each pocket are kept as inlays (previewed dark) for
  multicolor export.
- E3 (done): STL/STEP export from the Manifold union of terrain and
  plinth. Babylon CSG and the raised-text fallback are gone.

### Print sizing (done)

- The print holds its size (6" by default). Dragging the frame changes the
  ground it covers and the map scale, not the inches; changing the inches
  keeps the ground.
- Model height is set in inches (0.75" default, scaling with the print).
  Exaggeration follows from each resort's relief, 0.5–8×.

### Resort silhouette (done)

- "Resort" footprint, the default after picking a resort: the frame stays
  a rectangle on the map and the model is cut to an outline around its
  runs and lifts (buffered 3% of the print, bays closed at 7%, detached
  clusters and holes dropped). Polygon runs don't count: they aren't drawn,
  and OSM can map a whole backcountry zone as one. Lines tagged only to
  another ski area don't count either. Manifold intersects it, so edges
  are clean.
- Picking a resort frames it from the runs and lifts tagged to it. The
  index viewport is used only until those load.
- With the name on, a 4 mm slab follows the outline with a flat tab on
  the base side carrying the name and rose; the brand goes under the tab.

### Multicolor on smooth terrain (done, needs a slicer test)

- Runs and lifts are solid color bodies set flush into the terrain,
  0.6 mm deep (three layers). The white body is the terrain with those
  pockets cut out, so the bodies add back up to the original solid with
  nothing overlapping. The viewer shows these bodies, and the 3MF carries
  them. STL and STEP export the white body, so the runs read as grooves.
- Colors are settled in plan before any solid is cut: crossings go by
  priority (lifts, black, red, orange, blue, green, gray), regions under
  0.8 mm wide or 1 mm² are dropped, white walls under 0.4 mm go to the
  color beside them, and color stops 0.8 mm short of the model's edge.
- Export 3MF writes one body per filament as one assembly, with filament
  numbers in `Metadata/model_settings.config` for Bambu Studio and Orca.
- One AMS: white, three trail colors, black lifts and text. Second AMS:
  every color separate, gray lifts, forest below 60% of the relief.
- The Stacked finish (flat elevation steps with grooved runs) was removed:
  the product is smooth only, and its step-building lost geometry on real
  resorts. An old link's `ln` setting is ignored.
- Still open: preview colors come from the trail scheme, not the filament
  list, so lifts preview gray and print black on one AMS.

### Phase R2 — inlay bodies

- Done as color bodies on smooth terrain, above. Left from the original
  list: lift terminals as small bumps.

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
