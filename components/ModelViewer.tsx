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
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { STLExport } from "@babylonjs/serializers/stl";
import type { Manifold } from "manifold-3d";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildWatertight,
  buildShapedWatertight,
  DEFAULT_PALETTE,
} from "@/lib/mesh/watertight";
import { buildContourLines } from "@/lib/mesh/contours";
import { buildModelSolids, unionForExport, type BuiltModel } from "@/lib/mesh/engrave";
import { loadManifold, vertexDataFromManifold, type ColorAt } from "@/lib/mesh/manifold";
import { plateFacingDeg } from "@/lib/mesh/nameplate";
import {
  buildResortOutline,
  OUTLINE_PLINTH_HEIGHT_IN,
  outlineMask,
} from "@/lib/mesh/silhouette";
import type { Contour } from "@/lib/mesh/text";
import { plinthHeightInches } from "@/lib/mesh/plinth";
import { buildRunRibbons, resortFrontBearing, resortLinesOnPlane } from "@/lib/mesh/runs";
import { exportToStep } from "@/lib/mesh/step-export";
import { loadFont } from "@/lib/mesh/text";
import type { ElevationResponse } from "@/lib/elevation/types";
import type { ColorScheme } from "@/lib/resort/colors";
import type { ResortData } from "@/lib/resort/types";
import {
  pointInShape,
  shapeAABBHalf,
  shapeOutline,
  type Shape,
} from "@/lib/shape";
import type { Bbox } from "@/lib/types";

interface Props {
  bbox: Bbox;
  shape: Shape;
  /** Shape's pre-rotation dimensions in inches. */
  widthInches: number;
  heightInches: number;
  /** Degrees clockwise from north. */
  rotation: number;
  data: ElevationResponse;
  baseThicknessInches: number;
  verticalExaggeration: number;
  engraveLabel: boolean;
  engraveBrand: boolean;
  label?: string;
  /** The resort in frame, if any; it also decides which way the name plate faces. */
  resort: ResortData | null;
  /** Cut the model to the resort's outline when there is one. */
  silhouette: boolean;
  /** Drape the runs (and, with showLifts, the lifts) on the terrain. */
  showRuns: boolean;
  colorScheme: ColorScheme;
  showLifts: boolean;
  minRunWidthMm: number;
}

const RIBBON_LIFT_IN = 0.008;
const EDGE_COLOR = new Color4(0.08, 0.09, 0.12, 1);

function meshFromSolid(
  scene: Scene,
  name: string,
  solid: Manifold,
  material: StandardMaterial,
  colorAt?: ColorAt,
): Mesh {
  const mesh = new Mesh(name, scene);
  vertexDataFromManifold(solid, colorAt).applyToMesh(mesh, true);
  mesh.material = material;
  mesh.enableEdgesRendering(0.95);
  mesh.edgesWidth = 1.5;
  mesh.edgesColor = EDGE_COLOR;
  return mesh;
}

const UNDERSIDE_COLOR: [number, number, number] = [0.78, 0.79, 0.82];

/**
 * Re-paint a Manifold-built terrain: surface by height, walls in the
 * palette's base color, and the underside light so the brand pocket
 * is visible when the model is turned over.
 */
function terrainColorAt(baseY: number, topY: number): ColorAt {
  const span = Math.max(topY - baseY, 1e-6);
  return (_x, y, _z, ny) => {
    if (ny > 0.3 && y > baseY - 1e-4) return DEFAULT_PALETTE.surface((y - baseY) / span);
    if (y < baseY * 0.5) return UNDERSIDE_COLOR;
    return DEFAULT_PALETTE.base;
  };
}

function freeBuilt(built: BuiltModel | null) {
  if (!built) return;
  built.terrain.delete();
  built.plinth?.delete();
  for (const s of built.inlays) s.delete();
}

const MM_PER_INCH = 25.4;
const CONTOUR_COUNT = 14;

export default function ModelViewer({
  bbox,
  shape,
  data,
  widthInches,
  heightInches,
  rotation,
  baseThicknessInches,
  verticalExaggeration,
  engraveLabel,
  engraveBrand,
  label,
  resort,
  silhouette,
  showRuns,
  colorScheme,
  showLifts,
  minRunWidthMm,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const terrainRef = useRef<Mesh | null>(null);
  const plinthRef = useRef<Mesh | null>(null);
  const contoursRef = useRef<Mesh | null>(null);
  const ribbonsRef = useRef<Mesh[]>([]);
  const inlaysRef = useRef<Mesh[]>([]);
  /** Solids from the last completed boolean pass; what export uses. */
  const builtRef = useRef<BuiltModel | null>(null);
  const terrainMatRef = useRef<StandardMaterial | null>(null);
  const plinthMatRef = useRef<StandardMaterial | null>(null);
  const inlayMatRef = useRef<StandardMaterial | null>(null);
  const lightRef = useRef<DirectionalLight | null>(null);

  const [sunAzimuth, setSunAzimuth] = useState(135); // degrees
  const [showContours, setShowContours] = useState(true);
  // A trace only counts for the exact inputs it was made from, so a model
  // can never be cut to the previous resort's ring while the next is traced.
  const outlineInputs = useMemo(
    () =>
      silhouette && resort && shape === "rectangle"
        ? { bbox, data, shape, widthInches, heightInches, rotation, resort }
        : null,
    [silhouette, resort, bbox, data, shape, widthInches, heightInches, rotation],
  );
  const [traced, setTraced] = useState<{
    inputs: NonNullable<typeof outlineInputs>;
    ring: Contour | null;
  } | null>(null);
  const outline = traced && traced.inputs === outlineInputs ? traced.ring : null;

  useEffect(() => {
    if (!outlineInputs) return;
    let cancelled = false;
    loadManifold()
      .then((m) => {
        if (cancelled) return;
        const [halfW] = shapeAABBHalf(
          outlineInputs.shape,
          outlineInputs.widthInches,
          outlineInputs.heightInches,
          outlineInputs.rotation,
        );
        const cell = (halfW * 2) / (outlineInputs.data.width - 1);
        const ring = buildResortOutline(
          m,
          resortLinesOnPlane(outlineInputs),
          shapeOutline(
            outlineInputs.shape,
            outlineInputs.widthInches - 2 * cell,
            outlineInputs.heightInches - 2 * cell,
            outlineInputs.rotation,
          ),
          Math.max(outlineInputs.widthInches, outlineInputs.heightInches),
        );
        setTraced({ inputs: outlineInputs, ring });
      })
      .catch((err: unknown) => console.error("[silhouette] failed", err));
    return () => {
      cancelled = true;
    };
  }, [outlineInputs]);

  // The name plate (and the brand with it) goes on the resort's base
  // side; without resort data, or a clear base side, it stays on the
  // bottom edge of the frame. Snapped to the face it will actually use,
  // so a refreshed resort that lands on the same face rebuilds nothing.
  const plateFacing = useMemo(() => {
    if (!resort || !(engraveLabel || engraveBrand)) return undefined;
    const side = { shape, widthInches, heightInches, rotation };
    const front = resortFrontBearing({ bbox, data, ...side, resort });
    if (front === null) return undefined;
    return outline ? Math.round(front) : plateFacingDeg({ ...side, facing: front });
  }, [bbox, data, shape, widthInches, heightInches, rotation, resort, engraveLabel, engraveBrand, outline]);

  const plinthTopY = !engraveLabel ? 0 : outline ? OUTLINE_PLINTH_HEIGHT_IN : plinthHeightInches();

  const insideOutline = useMemo(() => {
    if (!outline) return undefined;
    const [halfW, halfH] = shapeAABBHalf(shape, widthInches, heightInches, rotation);
    return outlineMask(outline, halfW * 2, halfH * 2, data.width, data.height);
  }, [outline, shape, widthInches, heightInches, rotation, data.width, data.height]);

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

    // Materials are persistent across builds; the meshes themselves are
    // recreated each rebuild (so CSG engravings can cleanly replace them
    // without re-application wiping the engraving on the next render).
    const mat = new StandardMaterial("terrainMat", scene);
    mat.diffuseColor = new Color3(0.82, 0.83, 0.85);
    mat.specularColor = new Color3(0.03, 0.03, 0.04);
    mat.emissiveColor = new Color3(0.08, 0.08, 0.09);
    mat.backFaceCulling = false;
    terrainMatRef.current = mat;

    const pmat = new StandardMaterial("plinthMat", scene);
    pmat.diffuseColor = new Color3(0.72, 0.73, 0.76);
    pmat.specularColor = new Color3(0.03, 0.03, 0.04);
    pmat.emissiveColor = new Color3(0.07, 0.07, 0.08);
    pmat.backFaceCulling = false;
    plinthMatRef.current = pmat;

    // Name-plate fill bodies: previewed in a dark filament color.
    const imat = new StandardMaterial("inlayMat", scene);
    imat.diffuseColor = new Color3(0.12, 0.13, 0.16);
    imat.specularColor = new Color3(0.05, 0.05, 0.05);
    imat.emissiveColor = new Color3(0.03, 0.03, 0.04);
    imat.backFaceCulling = false;
    inlayMatRef.current = imat;

    engine.runRenderLoop(() => scene.render());

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
      terrainRef.current = null;
      plinthRef.current = null;
      contoursRef.current = null;
      ribbonsRef.current = [];
      inlaysRef.current = [];
      freeBuilt(builtRef.current);
      builtRef.current = null;
      lightRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 2. Rebuild terrain + (optional) plinth + engravings ---
  // The terrain VertexData is the same as before; the plinth is a
  // separate mesh that sits beneath the terrain (terrain shifts up by
  // plinthHeight). CSG operations engrave the label/compass into the
  // plinth bevel and "craftedcarving.com" into the bottom face.
  useEffect(() => {
    const scene = sceneRef.current;
    const terrainMat = terrainMatRef.current;
    const plinthMat = plinthMatRef.current;
    if (!scene || !terrainMat || !plinthMat) return;

    let cancelled = false;

    // Always rebuild from scratch; the boolean pass below replaces these
    // meshes once it finishes.
    terrainRef.current?.dispose();
    plinthRef.current?.dispose();
    for (const m of inlaysRef.current) m.dispose();
    inlaysRef.current = [];
    freeBuilt(builtRef.current);
    builtRef.current = null;

    const meshSpec = {
      bbox,
      data,
      widthInches,
      heightInches,
      baseThicknessInches,
      verticalExaggeration,
    };
    // Use the shape-aware path for anything that needs masking: a
    // non-rectangle shape, OR a rotated rectangle (since the grid then
    // spans the AABB, not the rectangle itself).
    const needsMask = shape !== "rectangle" || rotation !== 0;
    const { vertexData, inPerMeter } = needsMask
      ? buildShapedWatertight(meshSpec, shape, rotation)
      : buildWatertight(meshSpec);

    const terrain = new Mesh("terrain", scene);
    terrain.material = terrainMat;
    vertexData.applyToMesh(terrain, true);
    terrain.enableEdgesRendering(0.95);
    terrain.edgesWidth = 1.5;
    terrain.edgesColor = new Color4(0.08, 0.09, 0.12, 1);
    terrainRef.current = terrain;

    // With a plinth the terrain sits on top of it, so everything drawn in
    // terrain coordinates shifts up by the plinth height.
    terrain.position.y = plinthTopY;
    terrain.computeWorldMatrix(true);

    // Rebuild contour lines (replace any previous mesh). For non-rect
    // shapes, mask off cells outside the shape so the lines stop at the
    // same staircase boundary the mesh uses.
    contoursRef.current?.dispose();
    // When `needsMask`, the contour grid must use the same AABB extent
    // as the mesh; otherwise the marching-squares cells won't line up
    // with the masked geometry.
    const gw = data.width;
    const gh = data.height;
    const aabbHalf = needsMask
      ? shapeAABBHalf(shape, widthInches, heightInches, rotation)
      : [widthInches / 2, heightInches / 2];
    const Wgrid = aabbHalf[0] * 2;
    const Hgrid = aabbHalf[1] * 2;
    const xAt = (i: number) => -Wgrid / 2 + (i * Wgrid) / (gw - 1);
    const zAt = (j: number) => Hgrid / 2 - (j * Hgrid) / (gh - 1);
    const keptAt = (x: number, z: number) =>
      (!needsMask || pointInShape(shape, x, z, widthInches, heightInches, rotation)) &&
      (insideOutline?.(x, z) ?? true);
    const cellKept = needsMask || insideOutline
      ? (i: number, j: number) =>
          keptAt(xAt(i), zAt(j)) &&
          keptAt(xAt(i + 1), zAt(j)) &&
          keptAt(xAt(i), zAt(j + 1)) &&
          keptAt(xAt(i + 1), zAt(j + 1))
      : undefined;
    const contourData = buildContourLines({
      data,
      widthInches: Wgrid,
      heightInches: Hgrid,
      baseThicknessInches,
      inPerMeter,
      verticalExaggeration,
      count: CONTOUR_COUNT,
      lift: 0.005, // ~5 thousandths of an inch above the surface
      cellKept,
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
      // Slightly lifted dark line — readable on the mid-gray terrain.
      lineMesh.color = new Color3(0.18, 0.21, 0.26);
      lineMesh.isPickable = false;
      lineMesh.position.y = plinthTopY;
      lineMesh.setEnabled(showContours);
      contoursRef.current = lineMesh;
    }
    // ---------- Plinth, name plate, brand (Manifold, async) ----------
    // Font and WASM load once; after that the whole pass takes well
    // under a second even at high density. Results replace the plain
    // meshes above unless the inputs changed meanwhile.
    if (engraveLabel || engraveBrand || outline) {
      const positions = vertexData.positions;
      const indices = vertexData.indices;
      (async () => {
        try {
          const [m, font] = await Promise.all([loadManifold(), loadFont()]);
          if (cancelled || !positions || !indices) return;
          const built = buildModelSolids(m, font, { positions, indices }, {
            shape,
            widthInches,
            heightInches,
            rotation,
            facing: plateFacing,
            label: label ?? "",
            plinth: engraveLabel,
            brand: engraveBrand,
            outline,
          });
          if (cancelled) {
            freeBuilt(built);
            return;
          }
          builtRef.current = built;

          if ((engraveBrand && !built.plinth) || outline) {
            const topY = terrain.getBoundingInfo().boundingBox.maximum.y;
            const branded = meshFromSolid(
              scene,
              "terrain",
              built.terrain,
              terrainMat,
              terrainColorAt(baseThicknessInches, topY),
            );
            branded.position.y = plinthTopY;
            terrain.dispose();
            terrainRef.current = branded;
          }
          if (built.plinth) {
            plinthRef.current = meshFromSolid(scene, "plinth", built.plinth, plinthMat);
            const inlayMat = inlayMatRef.current ?? plinthMat;
            inlaysRef.current = built.inlays.map((solid, i) =>
              meshFromSolid(scene, `inlay-${i}`, solid, inlayMat),
            );
          }
        } catch (err) {
          console.error("[engraving] failed", err);
        }
      })();
    }

    // showContours is intentionally not a dep — toggling it is handled by
    // the next effect, which avoids rebuilding the geometry.
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox, shape, rotation, data, widthInches, heightInches, baseThicknessInches, verticalExaggeration, engraveLabel, engraveBrand, label, plateFacing, outline, insideOutline, plinthTopY]);

  // --- 2b. Runs + lifts draped on the terrain ---
  // Separate from the terrain rebuild so toggling lifts or changing the
  // width doesn't redo the (slow) CSG engraving. One mesh per color.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    for (const m of ribbonsRef.current) {
      m.material?.dispose();
      m.dispose();
    }
    ribbonsRef.current = [];
    if (!resort || !showRuns) return;

    const groups = buildRunRibbons({
      bbox,
      data,
      shape,
      widthInches,
      heightInches,
      rotation,
      baseThicknessInches,
      verticalExaggeration,
      resort,
      scheme: colorScheme,
      showLifts,
      minWidthMm: minRunWidthMm,
      lift: RIBBON_LIFT_IN,
      insideOutline,
    });

    ribbonsRef.current = groups.map((g) => {
      const mat = new StandardMaterial(`run-${g.name}`, scene);
      mat.diffuseColor = new Color3(...g.rgb);
      mat.emissiveColor = new Color3(g.rgb[0] * 0.25, g.rgb[1] * 0.25, g.rgb[2] * 0.25);
      mat.specularColor = new Color3(0.05, 0.05, 0.05);
      mat.backFaceCulling = false;
      const mesh = new Mesh(`runs-${g.name}`, scene);
      g.vertexData.applyToMesh(mesh, false);
      mesh.material = mat;
      mesh.position.y = plinthTopY;
      mesh.isPickable = false;
      return mesh;
    });
  }, [
    bbox,
    data,
    shape,
    widthInches,
    heightInches,
    rotation,
    baseThicknessInches,
    verticalExaggeration,
    plinthTopY,
    insideOutline,
    resort,
    showRuns,
    colorScheme,
    showLifts,
    minRunWidthMm,
  ]);

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

  // --- 5. Export ---
  // One solid: terrain lifted onto the plinth and unioned with it by
  // Manifold, so the seam between them is closed. Before the boolean
  // pass finishes (or when nothing is engraved) the plain terrain mesh
  // is exported as it stands.
  const exportGeometry = useCallback(async (): Promise<{
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
  } | null> => {
    if (!terrainRef.current) return null;
    const m = await loadManifold();
    // Read the solids only after the await: a rebuild during it frees
    // the previous set.
    const built = builtRef.current;
    const terrain = terrainRef.current;
    if (!terrain) return null;
    if (built) {
      const solid = unionForExport(m, built);
      try {
        const vd = vertexDataFromManifold(solid);
        return { positions: vd.positions!, indices: vd.indices! };
      } finally {
        solid.delete();
      }
    }
    // Without the solids an outline model would export as its uncut block.
    if (outlineInputs) return null;
    const positions = terrain.getVerticesData(VertexBuffer.PositionKind);
    const indices = terrain.getIndices();
    if (!positions || !indices) return null;
    if (terrain.position.y === 0) return { positions, indices };
    const lifted = Float32Array.from(positions);
    for (let i = 1; i < lifted.length; i += 3) lifted[i] += terrain.position.y;
    return { positions: lifted, indices };
  }, [outlineInputs]);

  const exportSTL = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    void exportGeometry().then((geom) => {
      if (!geom) return;
      const mesh = new Mesh("export-stl", scene);
      const vd = new VertexData();
      vd.positions = Float32Array.from(geom.positions);
      vd.indices = Uint32Array.from(geom.indices);
      vd.applyToMesh(mesh, false);
      mesh.scaling = new Vector3(MM_PER_INCH, MM_PER_INCH, MM_PER_INCH);
      mesh.isVisible = false;
      const filename = (label ? slug(label) : "ski-model") + ".stl";
      STLExport.CreateSTL([mesh], true, filename, true, true, false);
      mesh.dispose();
    }).catch((err: unknown) => console.error("[stl] export failed", err));
  }, [label, exportGeometry]);

  // STEP gives a true B-rep solid (each triangle → an ADVANCED_FACE in
  // a single MANIFOLD_SOLID_BREP) so CAD apps open the model as one
  // selectable object rather than a triangle soup.
  const exportSTEP = useCallback(() => {
    void exportGeometry().then((geom) => {
      if (!geom) return;
      const stepName = label ? slug(label) : "ski-model";
      const stepStr = exportToStep(
        { positions: Array.from(geom.positions), indices: Array.from(geom.indices) },
        { name: stepName, unitScale: MM_PER_INCH },
      );
      const blob = new Blob([stepStr], { type: "application/STEP" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = stepName + ".step";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch((err: unknown) => console.error("[step] export failed", err));
  }, [label, exportGeometry]);

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
        <button
          type="button"
          onClick={exportSTEP}
          className="w-full rounded-md border border-amber-400/60 text-amber-200 font-semibold py-1.5 hover:bg-amber-400/10 transition"
        >
          Export STEP
        </button>
        <p className="text-[10px] text-slate-500 leading-snug">
          STL for slicers, STEP for CAD. Both export in millimeters.
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
