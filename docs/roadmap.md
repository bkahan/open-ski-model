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
- Runs drawn on the 2D map and, on the 3D terrain, set in as flush color
  bodies, one per color (first shipped as draped ribbons). Lifts toggleable. Minimum run width (default 1.2 mm)
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
  chamfer slope (6–9 mm, see E5), shrunk to fit. A name that still won't fit at
  6 mm drops what follows a comma, then a trailing "Resort" / "Ski Area",
  and only then is cut with "…". Hexagon sides are too short to share, so
  the rose gets the next face.
  Fill bodies for each pocket are kept as inlays (previewed dark) for
  multicolor export.
- E3 (done): STL/STEP export from the Manifold union of terrain and
  plinth. Babylon CSG and the raised-text fallback are gone.
- E4 (done): a second line under the name for the town and state, set in
  capitals ("JAY, VT", "ZERMATT, SWITZERLAND"). The name is capped at 35%
  of the slope, the second line is 70% of that (never under 4.4 mm), both
  left-aligned, and the rose
  sits to their right, centered on the pair. The second line is the first
  thing given up: a plate too short for both lines is laid out exactly as
  it was with one. Picking a resort fills the line from the ski-area
  index, then replaces it with a Nominatim reverse lookup at the base
  area (the lift station most runs finish at), since the index's town is
  often a hamlet or the next town over. The line is editable and travels
  in the link as `place`.
- E5 (done for the plate, open for the brand and the rose): plate text
  sized and spaced for a 0.4 mm nozzle (`lib/mesh/printable.ts`).
  - Strokes are thickened until the font's thinnest straight stroke is
    0.8 mm, two passes of the nozzle. Roboto Regular's bars are 0.108 of
    the cap height, so anything under 7.4 mm tall is thickened.
  - Letters are spread by what the thickening took from the gaps, and
    letters the font sets tight (tt, rt, VT, the L and A of L'A) are
    moved apart until 0.5 mm of plate is left between any two.
  - Thickening narrows the openings inside letters. Lower case keeps
    0.5 mm openings down to 6 mm caps; below that the mouths of a, e, g
    and s close and the dots of i and j touch their stems. Capitals keep
    them down to 4.4 mm. Hence a 6 mm floor for the name (it was 3 mm)
    and capitals for the smaller second line.
  - Not yet done: the bottom brand (3 mm lower case, 0.38 mm strokes)
    and the compass letters (the S's openings are about 0.2 mm). Both
    need a size change that moves other things.

### Print sizing (done)

- The print holds its size (6" by default). Dragging the frame changes the
  ground it covers and the map scale, not the inches; changing the inches
  keeps the ground.
- Model height is set in inches (0.75" default, scaling with the print).
  Exaggeration follows from each resort's relief, 0.5–8×.
- Two ways to size (`lib/print-fit.ts`, `printFrame`):
  - Set size: as above. For the Resort shape the size is the mountain's
    longest side, measured square to its frame, and the hidden frame is
    built that much bigger (the outline is about 95% of its frame). The
    name tab is extra.
  - Set scale: 1 : N is typed or picked (10k to 50k presets, 1,000 to
    500,000 allowed) and the print comes out however big the covered
    ground is at it. The panel reads the size back in inches and mm, and
    says when it is past a 256 mm bed. Nothing over 100 in is built.
    Changing N keeps the vertical exaggeration by scaling the model
    height with it. The field takes "25,000", "1:25000" and "25k".
- The panel's size and the frame on the map stay a "layout" that every
  frame edit works on; only what is generated and read out goes through
  `printFrame`. Switching between the two ways keeps the print as it is
  (to the nearest whole N), unless the size's scale is outside 1,000 to
  500,000, in which case it moves to the nearest end.
- The map's outline is traced at one nominal size. On the ground it is
  the same ring at any print size (its share of the frame varied 0.950
  to 0.952 from 3 to 40 in on Jay Peak), so a size or scale change does
  not retrace it.
- Generate waits for the outline's trace whenever the frame it is
  traced in has changed, since the frame to build is sized off it.
- Open: prints bigger than the bed have no tiling yet, and there is no
  printer profile (bed, nozzle) to check against. The model height
  slider still stops at 4 in, which a print past about 30 in outgrows
  (the height is kept, but the slider can't show or set it).

### Resort silhouette (done)

- "Resort" footprint, the default after picking a resort: the model is
  cut to an outline around its runs and lifts (buffered 3% of the print,
  bays closed at 7%, detached clusters and holes dropped). Polygon runs
  don't count: they aren't drawn, and OSM can map a whole backcountry
  zone as one. Lines tagged only to another ski area don't count either.
  Manifold intersects it, so edges are clean.
- The map shows that outline, not a frame. It is traced by the same code
  the model is cut with (`lib/mesh/resort-outline.ts`). The frame behind
  it, a square turned to the resort's bearing, is fitted to the resort's
  lines and is not the user's to drag, size or turn. Until the lines have
  loaded there is nothing to generate.
- One rule says which lines are a ski area's (`resortLines`): those
  tagged to it, and untagged ones with a point within 5% of the tagged
  lines' bounds. The frame and the outline both use it. They used to
  differ, and a chain of untagged runs leading away from the resort ran
  the outline into the frame's edge, where it was cut off flat.
- Resort is on offer once a ski area has been picked in search. A first
  visit opens on Jay Peak picked that way; it used to open on a plain
  frame at a fixed center that cut Jay's west edge off.
- Rectangle, Circle and Hex are plain shapes: a frame to drag, never cut
  to a resort.
- Untagged runs that start outside that reach are left out unless
  "Follow connected runs" is on (Ski runs panel, off by default, `fc=1`
  in a link). It adds the untagged lines that cross or come within 30 m
  of the resort's lines, and the ones that join those, outward. The frame and
  outline are refitted. On Sugarloaf that is the four Burnt Mountain
  runs (frame 4.59 to 4.70 km). The data has no flag for "the resort
  lists this run", only whether lines meet, so the same rule takes the
  Teardrop backcountry trail at Stowe (frame 6.05 to 7.17 km). That is
  why it is a toggle.
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
- First slicer test (Bambu Studio, 2026-11-11): the bodies loaded as one
  multi-part object, but Studio said the file was not a Bambu 3MF, loaded
  geometry only, and every part had to be given its filament by hand.
  Studio treats a file as its own only when the model's Application
  metadata starts with `BambuStudio-`, and it does not keep a third-party
  file's filament numbers. The export now carries that mark. It no longer
  writes a `project_settings.config`: in a marked file a partial one
  would be loaded as the project's settings over bare defaults. Not yet
  re-tested in Studio.
- Still open for the 3MF: filament colors and types do not travel with
  the file, Studio shows a "geometry only" notice when the file is opened
  as a project, and it does not add filaments to its list on that path,
  so the list needs as many as the model has colors. All three need a
  full project config, built from a project saved by Studio.
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
