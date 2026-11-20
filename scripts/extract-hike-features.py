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


def feature_id(obj):
    if obj.is_node():
        return f"n{obj.id}"
    if obj.is_way():
        return f"w{obj.id}"
    if obj.is_area():
        return f"{'w' if obj.from_way() else 'r'}{obj.orig_id()}"
    return None


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: extract-hike-features.py <in.osm.pbf> <region> <out.geojsonseq>")
    source, region, target = sys.argv[1:]

    features = (
        osmium.FileProcessor(source)
        .with_locations()
        .with_areas()
        .with_filter(osmium.filter.TagFilter(*SELECT))
        .with_filter(osmium.filter.GeoInterfaceFilter(tags=KEEP_TAGS))
    )

    written = 0
    with open(target, "a", encoding="utf-8") as out:
        for obj in features:
            fid = feature_id(obj)
            if fid is None:
                continue
            feature = obj.__geo_interface__
            feature["id"] = fid
            feature["properties"]["region"] = region
            out.write(json.dumps(feature, ensure_ascii=False, separators=(",", ":")))
            out.write("\n")
            written += 1
    print(f"{region}: {written} features from {source}")


if __name__ == "__main__":
    main()
