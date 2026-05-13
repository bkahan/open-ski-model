"use client";

// Babylon.js 3D viewer (Phase 3).
//
// Upgrades over Phase 2:
//   - Watertight mesh (top + 4 walls + bottom) — exportable as STL.
//   - Contour-line overlay (marching squares, toggleable).
//   - Sun-angle azimuth slider so you can dial the hillshade.
//   - STL export button. The exported STL is scaled to millimeters so any
//     slicer treats it as life-sized at the chosen print dimensions.

import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { STLExport } from "@babylonjs/serializers/stl";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildWatertight } from "@/lib/mesh/watertight";
import { buildContourLines } from "@/lib/mesh/contours";
import type { ElevationResponse } from "@/lib/elevation/types";
import type { Bbox } from "@/lib/types";

interface Props {
  bbox: Bbox;
  data: ElevationResponse;
  widthInches: number;
  heightInches: number;
  baseThicknessInches: number;
  verticalExaggeration: number;
  label?: string;
}

const MM_PER_INCH = 25.4;
const CONTOUR_COUNT = 14;

export default function ModelViewer({
  bbox,
  data,
  widthInches,
  heightInches,
  baseThicknessInches,
  verticalExaggeration,
  label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const terrainRef = useRef<Mesh | null>(null);
  const contoursRef = useRef<Mesh | null>(null);
  const lightRef = useRef<DirectionalLight | null>(null);

  const [sunAzimuth, setSunAzimuth] = useState(135); // degrees
  const [showContours, setShowContours] = useState(true);

  // --- 1. Bootstrap engine + scene once ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
    });
    engineRef.current = engine;

    const scene = new Scene(engine);
    // Slightly lighter than the page bg so the model has visible contrast.
    scene.clearColor = new Color4(0.09, 0.12, 0.17, 1);
    sceneRef.current = scene;

    const span = Math.max(widthInches, heightInches);
    const camera = new ArcRotateCamera(
      "cam",
      Math.PI / 4,
      Math.PI / 3,
      span * 1.8,
      Vector3.Zero(),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = span * 0.5;
    camera.upperRadiusLimit = span * 6;
    camera.wheelDeltaPercentage = 0.01;
    camera.minZ = 0.01;

    // Hemispheric light with a bright `groundColor` is the trick that
    // makes this robust to normal direction. Even surfaces whose normals
    // happen to face "wrong" still pick up ~65% intensity, so the model
    // never goes pure black. The directional light adds the hillshade
    // gradient on top.
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.85;
    hemi.diffuse = new Color3(1, 1, 1);
    hemi.groundColor = new Color3(0.55, 0.55, 0.6);
    const dir = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.4), scene);
    dir.intensity = 0.65;
    lightRef.current = dir;

    const terrain = new Mesh("terrain", scene);
    const mat = new StandardMaterial("terrainMat", scene);
    // Solid medium gray with soft hillshade — reads cleanly as a topo
    // model without dark-on-dark palette confusion.
    mat.diffuseColor = new Color3(0.82, 0.83, 0.85);
    mat.specularColor = new Color3(0.03, 0.03, 0.04);
    mat.emissiveColor = new Color3(0.08, 0.08, 0.09); // floor of brightness
    mat.backFaceCulling = false;
    terrain.material = mat;

    // External silhouette: edges between adjacent triangles whose normals
    // differ by more than ~18° (epsilon 0.95) get drawn as thin dark
    // lines. Gives the model a clean outline against the background and
    // sharpens the seam between top surface and side walls.
    terrain.enableEdgesRendering(0.95);
    terrain.edgesWidth = 1.5;
    terrain.edgesColor = new Color4(0.08, 0.09, 0.12, 1);

    terrainRef.current = terrain;

    engine.runRenderLoop(() => scene.render());

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
      terrainRef.current = null;
      contoursRef.current = null;
      lightRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 2. Rebuild terrain + contours whenever inputs change ---
  useEffect(() => {
    const scene = sceneRef.current;
    const terrain = terrainRef.current;
    if (!scene || !terrain) return;

    const { vertexData, inPerMeter } = buildWatertight({
      bbox,
      data,
      widthInches,
      heightInches,
      baseThicknessInches,
      verticalExaggeration,
    });
    vertexData.applyToMesh(terrain, true);
    // applyToMesh swaps vertex buffers; the edges renderer caches edge
    // topology, so refresh it now that the geometry has changed.
    terrain.disableEdgesRendering();
    terrain.enableEdgesRendering(0.95);
    terrain.edgesWidth = 1.5;
    terrain.edgesColor = new Color4(0.08, 0.09, 0.12, 1);

    // Rebuild contour lines (replace any previous mesh).
    contoursRef.current?.dispose();
    const contourData = buildContourLines({
      data,
      widthInches,
      heightInches,
      baseThicknessInches,
      inPerMeter,
      verticalExaggeration,
      count: CONTOUR_COUNT,
      lift: 0.005, // ~5 thousandths of an inch above the surface
    });

    if (contourData.indices.length > 0) {
      const lines: Vector3[][] = [];
      const pos = contourData.positions;
      for (let k = 0; k < contourData.indices.length; k += 2) {
        const a = contourData.indices[k];
        const b = contourData.indices[k + 1];
        lines.push([
          new Vector3(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]),
          new Vector3(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]),
        ]);
      }
      const lineMesh = MeshBuilder.CreateLineSystem(
        "contours",
        { lines },
        scene,
      );
      lineMesh.color = new Color3(0.08, 0.10, 0.14);
      lineMesh.isPickable = false;
      lineMesh.setEnabled(showContours);
      contoursRef.current = lineMesh;
    }
    // showContours is intentionally not a dep — toggling it is handled by
    // the next effect, which avoids rebuilding the geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox, data, widthInches, heightInches, baseThicknessInches, verticalExaggeration]);

  // --- 3. Toggle contour visibility without rebuilding ---
  useEffect(() => {
    contoursRef.current?.setEnabled(showContours);
  }, [showContours]);

  // --- 4. Update sun direction ---
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    const az = (sunAzimuth * Math.PI) / 180;
    // Direction is the vector the light TRAVELS along (so flip the sun's
    // position to get its direction).
    const elev = (40 * Math.PI) / 180; // fixed sun elevation
    const x = -Math.cos(elev) * Math.sin(az);
    const z = -Math.cos(elev) * Math.cos(az);
    const y = -Math.sin(elev);
    light.direction = new Vector3(x, y, z);
  }, [sunAzimuth]);

  // --- 5. STL export ---
  const exportSTL = useCallback(() => {
    const scene = sceneRef.current;
    const terrain = terrainRef.current;
    if (!scene || !terrain) return;
    // STL has no unit metadata, but slicers default to mm. We clone the
    // mesh, scale to mm (× 25.4), bake the transform on export, dispose.
    const clone = terrain.clone("export-stl", null, true);
    if (!clone) return;
    clone.scaling = new Vector3(MM_PER_INCH, MM_PER_INCH, MM_PER_INCH);
    const filename = (label ? slug(label) : "ski-model") + ".stl";
    // CreateSTL: (meshes, download, fileName, binary, isLittleEndian, doNotBakeTransform)
    STLExport.CreateSTL([clone], true, filename, true, true, false);
    clone.dispose();
  }, [label]);

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full block outline-none"
        tabIndex={0}
      />
      {/* Floating toolbar */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2 bg-slate-950/80 backdrop-blur border border-slate-800 rounded-md p-3 text-xs w-56">
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-300">Sun azimuth</span>
          <span className="font-mono text-slate-100">{sunAzimuth}°</span>
        </label>
        <input
          type="range"
          min={0}
          max={359}
          value={sunAzimuth}
          onChange={(e) => setSunAzimuth(parseInt(e.target.value, 10))}
          className="accent-amber-400"
        />
        <label className="flex items-center gap-2 mt-1">
          <input
            type="checkbox"
            checked={showContours}
            onChange={(e) => setShowContours(e.target.checked)}
            className="accent-amber-400"
          />
          <span className="text-slate-300">Contour lines</span>
        </label>
        <button
          type="button"
          onClick={exportSTL}
          className="mt-2 w-full rounded-md bg-amber-400 text-slate-950 font-semibold py-1.5 hover:bg-amber-300 transition"
        >
          Export STL
        </button>
        <p className="text-[10px] text-slate-500 leading-snug">
          STL exports in millimeters — your slicer will treat it as life-size at
          the chosen print dimensions.
        </p>
      </div>
    </div>
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
