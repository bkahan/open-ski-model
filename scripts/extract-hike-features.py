"""Pulls the hiking features out of an OpenStreetMap extract.

Reads one .osm.pbf (a Geofabrik state extract) and appends one GeoJSON
feature per line to the output: paths and footways, peaks, huts,
trailheads, mountain ranges and water bodies. It only selects by tag and
resolves geometry; which of these count as hiking trails is decided in
scripts/build-hike-data.mjs, where the rules are unit tested.

Usage: python scripts/extract-hike-features.py <in.osm.pbf> <region> <out.geojsonseq>
`region` is stamped on every feature ("NH") and ends up in the search index.
"""

import json
import sys

import osmium

SELECT = [
    ("highway", "path"),
    ("highway", "footway"),
    ("highway", "trailhead"),
    ("natural", "peak"),
    ("natural", "water"),
    ("natural", "mountain_range"),
    ("tourism", "alpine_hut"),
    ("tourism", "wilderness_hut"),
]

KEEP_TAGS = [
    "highway",
    "footway",
    "natural",
    "water",
    "tourism",
    "name",
    "ele",
    "access",
    "foot",
    "informal",
    "surface",
    "sac_scale",
    "trail_visibility",
]


class HikeFeatures(osmium.SimpleHandler):
    """Writes each selected object as a line of GeoJSON.

    A closed way arrives twice, as a way (LineString) and as an area
    (MultiPolygon), under the same id. Extracts are cut along state lines
    and can hold ways whose nodes fell outside; those are skipped and
    counted, not allowed to stop the run.
    """

    def __init__(self, out, region):
        super().__init__()
        self.out = out
        self.region = region
        self.geojson = osmium.geom.GeoJSONFactory()
        self.written = 0
        self.skipped = 0

    def emit(self, fid, tags, make_geometry):
        try:
            geometry = json.loads(make_geometry())
        except (osmium.InvalidLocationError, RuntimeError):
            self.skipped += 1
            return
        properties = {key: tags[key] for key in KEEP_TAGS if key in tags}
        properties["region"] = self.region
        feature = {"type": "Feature", "id": fid, "properties": properties, "geometry": geometry}
        self.out.write(json.dumps(feature, ensure_ascii=False, separators=(",", ":")))
        self.out.write("\n")
        self.written += 1

    def node(self, n):
        self.emit(f"n{n.id}", n.tags, lambda: self.geojson.create_point(n))

    def way(self, w):
        self.emit(f"w{w.id}", w.tags, lambda: self.geojson.create_linestring(w))

    def area(self, a):
        fid = f"{'w' if a.from_way() else 'r'}{a.orig_id()}"
        self.emit(fid, a.tags, lambda: self.geojson.create_multipolygon(a))


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: extract-hike-features.py <in.osm.pbf> <region> <out.geojsonseq>")
    source, region, target = sys.argv[1:]

    with open(target, "a", encoding="utf-8") as out:
        handler = HikeFeatures(out, region)
        handler.apply_file(source, locations=True, filters=[osmium.filter.TagFilter(*SELECT)])
    print(f"{region}: {handler.written} features from {source}, {handler.skipped} skipped for missing nodes")
    if handler.written == 0:
        sys.exit(f"{region}: no hiking features in {source}")


if __name__ == "__main__":
    main()
