"use client";

// Traces a resort's outline for the map with the same code the model is
// cut by, off the same frame, so the two can't disagree.

import { useEffect, useState } from "react";

import { loadManifold } from "@/lib/mesh/manifold";
import { outlineOnMap, traceResortOutline, type OutlineSpec } from "@/lib/mesh/resort-outline";
import type { LngLat } from "@/lib/types";

interface Traced {
  spec: OutlineSpec;
  ring: LngLat[] | null;
}

export interface ResortOutline {
  /**
   * The ring on the map. While a new spec for the same ski area is being
   * traced (a size or density change) this is still the last one, so the
   * outline doesn't blink. Null before the first trace of an area, and
   * when there was nothing to trace.
   */
  ring: LngLat[] | null;
  /** False from a change of `spec` until its own trace is back. */
  settled: boolean;
}

/**
 * The outline for `spec`, or nothing for null. A trace is matched to the
 * exact spec it was made from, so pass a memoized one.
 */
export function useResortOutline(spec: OutlineSpec | null): ResortOutline {
  const [traced, setTraced] = useState<Traced | null>(null);

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    loadManifold()
      .then((m) => {
        if (cancelled) return;
        const ring = traceResortOutline(m, spec);
        setTraced({ spec, ring: ring ? outlineOnMap(spec, ring) : null });
      })
      .catch((err: unknown) => {
        console.error("[outline] trace failed", err);
        if (!cancelled) setTraced({ spec, ring: null });
      });
    return () => {
      cancelled = true;
    };
  }, [spec]);

  if (!spec) return { ring: null, settled: true };
  if (traced?.spec === spec) return { ring: traced.ring, settled: true };
  const sameArea = traced !== null && traced.spec.areaId === spec.areaId;
  return { ring: sameArea ? traced.ring : null, settled: false };
}
