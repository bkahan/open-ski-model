# Roadmap

## Done

- Phases 1–3: map picker, server-side elevation (terrarium + USGS 3DEP),
  watertight mesh, shapes, plinth + CSG engravings, STL / STEP export,
  share-by-URL, PWA.

## Multicolor resort models

Goal: type a resort name, get a print-ready multicolor model with runs
colored by difficulty and lifts as stripes.

### Phase R1 — resort data + overlay (done)

- `POST /api/resort` fetches downhill runs (`piste:type=downhill`) and lifts
  (`aerialway=*`) from OpenStreetMap via Overpass, cached in memory.
- Runs drawn on the 2D map and draped on the 3D terrain as ribbons, one
  mesh per color. Lifts toggleable. Minimum run width (default 1.2 mm)
  widens anything narrower.
- Color scheme auto-picked by hemisphere (N. America green/blue/black,
  Europe blue/red/black), overridable.
- Search auto-frames the bbox around the resort's runs when the area has
  at least three.
- Settings mirrored in the URL (`runs`, `lf`, `mw`, `cs`).

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

- Overpass public endpoint rate-limits; set `OVERPASS_URL` to a private
  instance for heavy use.
- Runs mapped as polygons (`area:piste=yes`) are drawn by their outline.
- Trail colors can clash with the hypsometric terrain palette in the
  viewer (green on green); the print base will be white.
