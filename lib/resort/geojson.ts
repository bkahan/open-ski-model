// Resort data as GeoJSON for the 2D map, with the resolved color baked
// into each feature so the layer style stays a plain data-driven lookup.

import type { Feature, FeatureCollection, LineString } from "geojson";

import { liftColor, runColor, type ColorScheme } from "./colors";
import type { ResortData } from "./types";

export interface ResortFeatureProps {
  kind: "run" | "lift";
  name: string;
  color: string;
}

export type ResortFeatureCollection = FeatureCollection<LineString, ResortFeatureProps>;

export const EMPTY_RESORT_GEOJSON: ResortFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function resortToGeoJSON(
  resort: ResortData,
  scheme: ColorScheme,
  includeLifts: boolean,
): ResortFeatureCollection {
  const features: Array<Feature<LineString, ResortFeatureProps>> = [];

  for (const run of resort.runs) {
    features.push({
      type: "Feature",
      id: run.id,
      geometry: { type: "LineString", coordinates: run.coords },
      properties: {
        kind: "run",
        name: run.name ?? "",
        color: runColor(run.difficulty, scheme).hex,
      },
    });
  }

  if (includeLifts) {
    for (const lift of resort.lifts) {
      features.push({
        type: "Feature",
        id: lift.id,
        geometry: { type: "LineString", coordinates: lift.coords },
        properties: {
          kind: "lift",
          name: lift.name ?? "",
          color: liftColor(lift.type).hex,
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
