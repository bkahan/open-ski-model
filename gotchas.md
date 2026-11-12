# Gotchas

Lessons from corrections, turned into rules. Read at the start of a session.

## Check every printed feature against the nozzle, text included

2026-11-11. The name plate's second line shipped at 3.35 mm tall with
0.42 mm strokes, one pass of a 0.4 mm nozzle at best. The run colors had
a minimum width; the text did not.

- Anything meant to print in its own color needs strokes of at least
  0.8 mm (two passes) and at least 0.5 mm of the other color around and
  inside it. That goes for letters as much as for runs.
- A font's size is not its stroke width. Roboto Regular's thin strokes
  are 0.108 of the cap height: 6 mm letters have 0.65 mm bars.
- Thickening strokes closes the openings inside letters. Measure both.
  Lower case holds up down to 6 mm caps, capitals down to 4.4 mm.
- Don't judge printability from a picture. An early look said thickened
  4.8 mm lower case was fine; measuring the openings said it was not.
- `lib/mesh/printable.ts` holds the limits. New text goes through
  `layoutPrintableLine` and `thickenedContours`, not straight from the font.

## Stand-in data hides data bugs

2026-11-11. US terrain came back from USGS squeezed north to south, and
runs appeared to carry on downhill past the summit. The sandbox tests
used made-up terrain, so they could not have caught it.

- A check that runs on stand-in data says nothing about the real
  service. Say which parts were only checked that way.
- When a request and its reply should cover the same ground, assert it:
  compare the extent that came back with the extent that was asked for.

## A file format is not checked until its reader has opened it

2026-11-11. The 3MF carried filament numbers in the right place, but
Bambu Studio did not use them: the file did not claim to be a Bambu
file. Unit tests only checked that the numbers were written.

- "Written correctly" is a claim about the writer. Whether a slicer uses
  the data is a claim about the reader: read its source or open the file
  in it before calling the export done.
- Bambu Studio's reader is `src/libslic3r/Format/bbs_3mf.cpp`, and the
  load decisions are in `Plater.cpp` (`load_files`). Check there first.
- Don't ship a partial `project_settings.config` in a file marked as
  Bambu's. Studio loads it over bare defaults as the project's settings.
- Say which reader version the source was read at. Studio's load logic
  has changed between releases, and the first explanation written for
  this bug described a guard that the current source does not have.

## Two things that must agree need one rule, not two that look alike

2026-11-11. A resort's frame was fitted to one set of lines and its
outline traced around another. They agreed on most resorts. Where
untagged runs led away from the resort, the outline ran into the frame's
edge and was cut off flat.

- When one result has to fit inside another, compute both from the same
  inputs through the same function (`resortLines`), and test the
  containment, not each half.
- The first visit is a state too. The default view cut Jay Peak's edge
  and no test or walkthrough looked at it, because every check started
  with a search.

## Don't stack pull requests the owner merges from a phone

2026-11-11. Four stacked PRs were merged bottom-up within two minutes.
Each landed in its own base branch, and `main` ended up without most of
the work. It happened a second time when a fix was left pointed at a
branch that had already been merged.

- Open every PR against `main`. If one needs another first, say so and
  wait for the merge before opening the next, or put both in one PR.
- After the owner says "merged", check that `main` has the commits
  before building on it.

## A map layer waiting for "idle" waits for every tile

2026-11-11. Runs and the outline were added to the map on its next
`idle`, which only comes when all tiles have loaded. With tiles slow or
failing, the layers never appeared.

- `isStyleLoaded()` is false while tiles are loading. Add sources when
  the style can take them (`whenStyleReady` in `MapPicker.tsx`).
