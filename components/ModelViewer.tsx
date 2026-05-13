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
  CSG,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { STLExport } from "@babylonjs/serializers/stl";
import type * as opentype from "opentype.js";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildWatertight, buildShapedWatertight } from "@/lib/mesh/watertight";
import { buildContourLines } from "@/lib/mesh/contours";
import { buildPlinth } from "@/lib/mesh/plinth";
import { buildTextMesh, loadFont, measureTextWidth } from "@/lib/mesh/text";
import { buildCompassArrow } from "@/lib/mesh/compass";
import type { ElevationResponse } from "@/lib/elevation/types";
import {
  pointInShape,
  shapeAABBHalf,
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
}

const BEVEL_DEG = 35;
const BRAND_TEXT = "craftedcarving.com";
const ENGRAVE_DEPTH_IN = 0.04; // ~1 mm
const LABEL_CAP_HEIGHT_IN = 0.18;
const BRAND_CAP_HEIGHT_IN = 0.12;
const COMPASS_SIZE_IN = 0.45;

interface ApplyEngravingsArgs {
  scene: Scene;
  font: opentype.Font;
  /** Current plinth mesh (may be replaced with an engraved version). */
  plinthMesh: Mesh | null;
  /** Current terrain mesh (used as the brand host if no plinth). */
  terrainMesh: Mesh;
  shape: Shape;
  widthInches: number;
  heightInches: number;
  rotation: number;
  baseThicknessInches: number;
  engraveLabel: boolean;
  engraveBrand: boolean;
  placeLabel: string;
  plinthHeight: number;
}

interface ApplyEngravingsResult {
  /** Replacement plinth mesh (engraved). Null if no plinth or no engraving. */
  newPlinth: Mesh | null;
  /** Replacement terrain mesh (only set if brand applied to terrain). */
  newTerrain: Mesh | null;
}

/**
 * Build engraving meshes (label, compass, brand) and subtract them from
 * the plinth and/or terrain via Babylon CSG. Returns the replacement
 * meshes — caller is responsible for updating refs and disposing the
 * originals.
 */
async function applyEngravings(args: ApplyEngravingsArgs): Promise<ApplyEngravingsResult> {
  const {
    scene,
    font,
    plinthMesh,
    terrainMesh,
    widthInches,
    heightInches,
    rotation,
    engraveLabel,
    engraveBrand,
    placeLabel,
    plinthHeight,
  } = args;

  // South-edge midpoint of the shape, in shape-local coords. For
  // rectangle / hex / circle, the bottom (south) extends to z =
  // -heightInches/2 (for circle, heightInches == widthInches).
  const southZ = -heightInches / 2;
  const tanBevel = Math.tan((BEVEL_DEG * Math.PI) / 180);
  const bevelW = plinthHeight / tanBevel;
  const bevelMidZLocal = southZ - bevelW / 2;
  const bevelMidYLocal = plinthHeight / 2;
  const θ = (rotation * Math.PI) / 180;
  const cosθ = Math.cos(θ);
  const sinθ = Math.sin(θ);

  const localToWorld = (lx: number, ly: number, lz: number) =>
    new Vector3(lx * cosθ - lz * sinθ, ly, lx * sinθ + lz * cosθ);

  // Engraving on the bevel: tilt by −BEVEL_DEG around local X first
  // (so the polygon lays on the slope), then rotate by the shape's
  // world rotation around Y. Quaternion multiplication in Babylon
  // applies right-to-left, so qShape.multiply(qBevel) = bevel then shape.
  const qBevel = Quaternion.RotationAxis(
    new Vector3(1, 0, 0),
    (-BEVEL_DEG * Math.PI) / 180,
  );
  const qShape = Quaternion.RotationAxis(new Vector3(0, 1, 0), θ);
  const bevelEngravingRotation = qShape.multiply(qBevel);

  const plinthNegatives: Mesh[] = [];
  const brandNegatives: Mesh[] = [];

  // --- Label text ---
  if (engraveLabel && plinthMesh && placeLabel.trim()) {
    const labelMesh = buildTextMesh({
      font,
      text: placeLabel,
      size: LABEL_CAP_HEIGHT_IN,
      depth: ENGRAVE_DEPTH_IN * 2,
      scene,
      name: "label-glyphs",
    });
    if (labelMesh) {
      labelMesh.setEnabled(false);
      const w = measureTextWidth(font, placeLabel, LABEL_CAP_HEIGHT_IN);
      labelMesh.position.x = -w / 2;
      labelMesh.bakeCurrentTransformIntoVertices();
      const worldPos = localToWorld(0, bevelMidYLocal, bevelMidZLocal);
      labelMesh.position = worldPos;
      labelMesh.rotationQuaternion = bevelEngravingRotation;
      plinthNegatives.push(labelMesh);
    }
  }

  // --- Compass arrow ---
  if (engraveLabel && plinthMesh) {
    const compassMesh = buildCompassArrow({
      size: COMPASS_SIZE_IN,
      depth: ENGRAVE_DEPTH_IN * 2,
      modelRotationDeg: rotation,
      scene,
      name: "compass",
    });
    if (compassMesh) {
      compassMesh.setEnabled(false);
      const offsetX = 0.55 * (widthInches / 2);
      const worldPos = localToWorld(offsetX, bevelMidYLocal, bevelMidZLocal);
      compassMesh.position = worldPos;
      compassMesh.rotationQuaternion = bevelEngravingRotation;
      plinthNegatives.push(compassMesh);
    }
  }

  // --- Brand on bottom face ---
  if (engraveBrand) {
    const brandMesh = buildTextMesh({
      font,
      text: BRAND_TEXT,
      size: BRAND_CAP_HEIGHT_IN,
      depth: ENGRAVE_DEPTH_IN * 2,
      scene,
      name: "brand-glyphs",
    });
    if (brandMesh) {
      brandMesh.setEnabled(false);
      const w = measureTextWidth(font, BRAND_TEXT, BRAND_CAP_HEIGHT_IN);
      brandMesh.position.x = -w / 2;
      brandMesh.bakeCurrentTransformIntoVertices();
      // 180° rotation around X flips the extrusion direction so the
      // depth points UP into the model AND inverts Z (letter-top now
      // points south). Combined with qShape this matches what a viewer
      // sees when they look at the underside. Importantly we do NOT
      // use negative scaling — that would invert face winding and
      // CSG.subtract would see the brand mesh as the COMPLEMENT volume
      // (effectively no-op or worse, eating the entire host).
      const qXFlip = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
      brandMesh.rotationQuaternion = qShape.multiply(qXFlip);
      // Slight overlap below y=0 so CSG doesn't trip on coplanar faces.
      brandMesh.position.y = -0.005;
      brandNegatives.push(brandMesh);
    }
  }

  let newPlinth: Mesh | null = null;
  let newTerrain: Mesh | null = null;

  // CSG subtract plinth negatives from plinth.
  if (plinthMesh && plinthNegatives.length) {
    try {
      for (const n of plinthNegatives) {
        n.computeWorldMatrix(true);
        n.bakeCurrentTransformIntoVertices();
      }
      plinthMesh.computeWorldMatrix(true);
      let plinthCSG = CSG.FromMesh(plinthMesh);
      for (const n of plinthNegatives) {
        plinthCSG = plinthCSG.subtract(CSG.FromMesh(n));
      }
      const engraved = plinthCSG.toMesh(
        "plinth-engraved",
        plinthMesh.material,
        scene,
        true,
      );
      // Sanity check: CSG occasionally returns an empty mesh when the
      // inputs aren't perfectly watertight. Keep the original plinth
      // in that case rather than replacing it with nothing.
      if (engraved.getTotalVertices() === 0) {
        // eslint-disable-next-line no-console
        console.warn("[engraving] plinth CSG produced empty mesh — keeping original plinth");
        engraved.dispose();
      } else {
        engraved.enableEdgesRendering(0.95);
        engraved.edgesWidth = 1.5;
        engraved.edgesColor = new Color4(0.08, 0.09, 0.12, 1);
        newPlinth = engraved;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[engraving] plinth CSG failed", err);
    } finally {
      for (const n of plinthNegatives) n.dispose();
    }
  }

  // CSG subtract brand negatives from whichever has the bottom face.
  if (brandNegatives.length) {
    // Host is the engraved plinth (if any), then the original plinth,
    // then the terrain.
    const host = newPlinth ?? plinthMesh ?? terrainMesh;
    try {
      for (const n of brandNegatives) {
        n.computeWorldMatrix(true);
        n.bakeCurrentTransformIntoVertices();
      }
      host.computeWorldMatrix(true);
      let hostCSG = CSG.FromMesh(host);
      for (const n of brandNegatives) {
        hostCSG = hostCSG.subtract(CSG.FromMesh(n));
      }
      const engraved = hostCSG.toMesh(host.name + "-engraved", host.material, scene, true);
      if (engraved.getTotalVertices() === 0) {
        // eslint-disable-next-line no-console
        console.warn("[engraving] brand CSG produced empty mesh — keeping original host");
        engraved.dispose();
      } else {
        engraved.enableEdgesRendering(0.95);
        engraved.edgesWidth = 1.5;
        engraved.edgesColor = new Color4(0.08, 0.09, 0.12, 1);
        if (host === terrainMesh) {
          newTerrain = engraved;
        } else {
          // Replace newPlinth (or plinthMesh) with the brand-engraved one.
          newPlinth?.dispose();
          newPlinth = engraved;
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[engraving] brand CSG failed", err);
    } finally {
      for (const n of brandNegatives) n.dispose();
    }
  }

  return { newPlinth, newTerrain };
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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const terrainRef = useRef<Mesh | null>(null);
  const plinthRef = useRef<Mesh | null>(null);
  const contoursRef = useRef<Mesh | null>(null);
  const terrainMatRef = useRef<StandardMaterial | null>(null);
  const plinthMatRef = useRef<StandardMaterial | null>(null);
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

    // Dispose any prior meshes — we always rebuild from scratch so CSG
    // engravings don't get wiped by applyToMesh on the next rebuild.
    terrainRef.current?.dispose();
    plinthRef.current?.dispose();

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

    // The plinth occupies y ∈ [0, plinthTopY]; when present, the
    // terrain is shifted up so its bottom sits on the plinth's top.
    // We need this constant before the contour block (contours shift
    // with the terrain) and before the plinth construction below.
    const plinthTopY = baseThicknessInches;
    terrain.position.y = engraveLabel ? plinthTopY : 0;
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
    const cellKept = needsMask
      ? (i: number, j: number) =>
          pointInShape(shape, xAt(i), zAt(j), widthInches, heightInches, rotation) &&
          pointInShape(shape, xAt(i + 1), zAt(j), widthInches, heightInches, rotation) &&
          pointInShape(shape, xAt(i), zAt(j + 1), widthInches, heightInches, rotation) &&
          pointInShape(shape, xAt(i + 1), zAt(j + 1), widthInches, heightInches, rotation)
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
      // Contour y-values are computed relative to the terrain's own
      // origin (base = baseThicknessInches). When the plinth is enabled
      // the terrain mesh shifts UP by plinthTopY; the contours need the
      // same shift or they hide INSIDE the plinth.
      lineMesh.position.y = engraveLabel ? plinthTopY : 0;
      lineMesh.setEnabled(showContours);
      contoursRef.current = lineMesh;
    }
    // ---------- Plinth ----------
    if (engraveLabel) {
      const bevelW =
        baseThicknessInches /
        Math.tan((BEVEL_DEG * Math.PI) / 180);

      const plinthResult = buildPlinth({
        shape,
        widthInches,
        heightInches,
        rotation,
        bevelDeg: BEVEL_DEG,
        bevelWidthInches: bevelW,
        plinthTopY,
      });

      const plinthMesh = new Mesh("plinth", scene);
      plinthMesh.material = plinthMat;
      plinthResult.vertexData.applyToMesh(plinthMesh, true);
      plinthMesh.enableEdgesRendering(0.95);
      plinthMesh.edgesWidth = 1.5;
      plinthMesh.edgesColor = new Color4(0.08, 0.09, 0.12, 1);
      plinthRef.current = plinthMesh;
    }

    // ---------- Async engraving via CSG ----------
    // Font loading is async, and CSG.subtract can be slow on dense
    // meshes, so we run engravings off the main paint and bail out if
    // inputs change before we finish.
    const doEngrave = (engraveLabel && plinthRef.current) || engraveBrand;
    if (doEngrave) {
      (async () => {
        try {
          const font = await loadFont();
          if (cancelled) return;
          const { newPlinth, newTerrain } = await applyEngravings({
            scene,
            font,
            plinthMesh: plinthRef.current,
            terrainMesh: terrain,
            shape,
            widthInches,
            heightInches,
            rotation,
            baseThicknessInches,
            engraveLabel,
            engraveBrand,
            placeLabel: label ?? "",
            plinthHeight: plinthTopY,
          });
          if (cancelled) {
            newPlinth?.dispose();
            newTerrain?.dispose();
            return;
          }
          // Replace plinth ref if we got an engraved version.
          if (newPlinth) {
            plinthRef.current?.dispose();
            plinthRef.current = newPlinth;
          }
          // Replace terrain ref if the brand was engraved on the
          // terrain (no plinth case). The new mesh inherits the
          // material; we need to preserve the position offset.
          if (newTerrain) {
            const oldY = terrain.position.y;
            newTerrain.position.y = oldY;
            terrainRef.current = newTerrain;
            terrain.dispose();
          }
        } catch (err) {
          // eslint-disable-next-line no-console
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
  }, [bbox, shape, rotation, data, widthInches, heightInches, baseThicknessInches, verticalExaggeration, engraveLabel, engraveBrand, label]);

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
  // When the plinth is present we CSG-union it with the terrain so the
  // exported STL is a single watertight solid (separate meshes would
  // produce non-manifold seams where the plinth top meets the terrain
  // bottom). Plinth + terrain union is small relative to the engraving
  // subtracts — it should finish in well under a second even at high
  // density.
  const exportSTL = useCallback(() => {
    const scene = sceneRef.current;
    const terrain = terrainRef.current;
    if (!scene || !terrain) return;
    const plinth = plinthRef.current;

    let exportMesh: Mesh | null = null;
    if (plinth) {
      try {
        terrain.computeWorldMatrix(true);
        plinth.computeWorldMatrix(true);
        const unionCSG = CSG.FromMesh(terrain).union(CSG.FromMesh(plinth));
        exportMesh = unionCSG.toMesh(
          "export-union",
          terrain.material,
          scene,
          true,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[stl] union failed; falling back to multi-mesh export", err);
      }
    }
    if (!exportMesh) {
      // Fallback: clone meshes and export them as multiple shells. This
      // is what users were getting before; it works but produces a
      // technically non-manifold STL.
      const clones: Mesh[] = [];
      const terrainClone = terrain.clone("export-terrain", null, true);
      if (terrainClone) {
        terrainClone.scaling = new Vector3(MM_PER_INCH, MM_PER_INCH, MM_PER_INCH);
        clones.push(terrainClone);
      }
      if (plinth) {
        const plinthClone = plinth.clone("export-plinth", null, true);
        if (plinthClone) {
          plinthClone.scaling = new Vector3(MM_PER_INCH, MM_PER_INCH, MM_PER_INCH);
          clones.push(plinthClone);
        }
      }
      if (!clones.length) return;
      const filename = (label ? slug(label) : "ski-model") + ".stl";
      STLExport.CreateSTL(clones, true, filename, true, true, false);
      for (const c of clones) c.dispose();
      return;
    }

    exportMesh.scaling = new Vector3(MM_PER_INCH, MM_PER_INCH, MM_PER_INCH);
    const filename = (label ? slug(label) : "ski-model") + ".stl";
    STLExport.CreateSTL([exportMesh], true, filename, true, true, false);
    exportMesh.dispose();
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
