// STEP (ISO 10303-21) exporter.
//
// Emits faceted B-rep solids: each input mesh becomes its own
// MANIFOLD_SOLID_BREP. Adjacent triangles within a mesh share
// VERTEX_POINT and EDGE_CURVE entities (vertex deduplication by exact
// XYZ position) so each solid is a single selectable object in CAD
// apps (Fusion 360, SolidWorks, FreeCAD, etc.) — unlike STL, which is
// just a triangle soup with no topology.
//
// Why per-mesh, not one merged solid: STEP's MANIFOLD_SOLID_BREP is a
// strict closed-manifold contract. Two watertight meshes that happen
// to touch at a plane do NOT compose into a watertight whole when
// concatenated — the shared region becomes internal duplicated faces.
// And Babylon's CSG.union doesn't actually produce a watertight mesh
// either (it leaves open edges at the join). So we keep each input
// mesh as its own solid; CAD apps see them as separate bodies under
// one product, which the user can stitch / merge if desired.
//
// Output: a Part-21 (ASCII) STEP file as a string. Conforms to AP203
// (CONFIG_CONTROL_DESIGN), which is the most widely supported flavor.

export interface StepExportOptions {
  /** Product name embedded in the STEP file. */
  name?: string;
  /**
   * Conversion factor from mesh units to STEP length unit (mm).
   * Default 25.4 — our meshes are in inches, STEP wants mm.
   */
  unitScale?: number;
}

export interface StepMeshInput {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Optional label for this body (e.g., "terrain"). Becomes the MANIFOLD_SOLID_BREP name. */
  name?: string;
}

/**
 * Convert one or more triangle meshes to a STEP file. Each input mesh
 * becomes its own MANIFOLD_SOLID_BREP under a single PRODUCT. Pass a
 * single object for one solid, or an array for a multi-body part.
 */
export function exportToStep(
  data: StepMeshInput | StepMeshInput[],
  opts: StepExportOptions = {},
): string {
  const productName = (opts.name ?? "ski-model").replace(/'/g, "");
  const unitScale = opts.unitScale ?? 25.4;
  const inputs = Array.isArray(data) ? data : [data];

  const lines: string[] = [];
  let nextId = 1;
  const newId = () => nextId++;

  // Emit each input mesh as its own MANIFOLD_SOLID_BREP.
  const bodyIds: number[] = [];
  for (let bi = 0; bi < inputs.length; bi++) {
    const bodyName = (inputs[bi].name ?? `${productName}-${bi + 1}`).replace(/'/g, "");
    const id = emitBody(inputs[bi], bodyName, lines, newId, unitScale);
    if (id !== null) bodyIds.push(id);
  }
  if (bodyIds.length === 0) {
    throw new Error("STEP export: no valid meshes (all were empty or degenerate)");
  }

  // Coordinate system + product / context boilerplate. AP203 expects
  // this skeleton so any reader can resolve the shape's context.
  const worldOriginCP = newId();
  lines.push(`#${worldOriginCP} = CARTESIAN_POINT('',(0.,0.,0.));`);
  const zDir = newId();
  lines.push(`#${zDir} = DIRECTION('',(0.,0.,1.));`);
  const xDir = newId();
  lines.push(`#${xDir} = DIRECTION('',(1.,0.,0.));`);
  const worldAxis = newId();
  lines.push(
    `#${worldAxis} = AXIS2_PLACEMENT_3D('',#${worldOriginCP},#${zDir},#${xDir});`,
  );

  const lengthUnit = newId();
  lines.push(
    `#${lengthUnit} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
  );
  const angleUnit = newId();
  lines.push(
    `#${angleUnit} = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );`,
  );
  const solidAngleUnit = newId();
  lines.push(
    `#${solidAngleUnit} = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );`,
  );
  const uncertaintyMeasure = newId();
  lines.push(
    `#${uncertaintyMeasure} = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-5),#${lengthUnit},'distance_accuracy_value','');`,
  );
  const geomContext = newId();
  lines.push(
    `#${geomContext} = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyMeasure})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) REPRESENTATION_CONTEXT('','3D') );`,
  );

  const shapeRep = newId();
  const repItems = [
    `#${worldAxis}`,
    ...bodyIds.map((id) => `#${id}`),
  ].join(",");
  lines.push(
    `#${shapeRep} = ADVANCED_BREP_SHAPE_REPRESENTATION('${productName}',(${repItems}),#${geomContext});`,
  );

  const appContext = newId();
  lines.push(
    `#${appContext} = APPLICATION_CONTEXT('configuration controlled 3D designs of mechanical parts and assemblies');`,
  );
  // APPLICATION_PROTOCOL_DEFINITION — terminal entity, referenced by
  // nothing in the graph but required to be present in the DATA section.
  lines.push(
    `#${newId()} = APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,#${appContext});`,
  );
  const productContext = newId();
  lines.push(
    `#${productContext} = PRODUCT_CONTEXT('',#${appContext},'mechanical');`,
  );
  const product = newId();
  lines.push(
    `#${product} = PRODUCT('${productName}','${productName}','',(#${productContext}));`,
  );
  const productFormation = newId();
  lines.push(
    `#${productFormation} = PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${product},.NOT_KNOWN.);`,
  );
  const designContext = newId();
  lines.push(
    `#${designContext} = PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design');`,
  );
  const productDef = newId();
  lines.push(
    `#${productDef} = PRODUCT_DEFINITION('','',#${productFormation},#${designContext});`,
  );
  const productDefShape = newId();
  lines.push(
    `#${productDefShape} = PRODUCT_DEFINITION_SHAPE('','',#${productDef});`,
  );
  // SHAPE_DEFINITION_REPRESENTATION — terminal; binds the product
  // definition to its shape representation. Not referenced elsewhere.
  lines.push(
    `#${newId()} = SHAPE_DEFINITION_REPRESENTATION(#${productDefShape},#${shapeRep});`,
  );

  const ts = new Date().toISOString().replace(/\.\d+Z$/, "");
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Open Ski Model export'),'2;1');",
    `FILE_NAME('${productName}.step','${ts}',(''),(''),'Open Ski Model','','');`,
    "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    "ENDSEC;",
    "DATA;",
  ].join("\n");
  const footer = ["ENDSEC;", "END-ISO-10303-21;", ""].join("\n");

  return header + "\n" + lines.join("\n") + "\n" + footer;
}

/**
 * Emit one body (vertex points + edges + faces + closed shell +
 * manifold solid) into `lines`. Returns the MANIFOLD_SOLID_BREP entity
 * id, or null if the input had no valid triangles.
 */
function emitBody(
  input: StepMeshInput,
  bodyName: string,
  lines: string[],
  newId: () => number,
  unitScale: number,
): number | null {
  const { positions, indices } = input;

  // 1. Dedup vertices by exact scaled XYZ. Two triangles sharing an
  //    edge must reference the same VERTEX_POINT so the shell is
  //    topologically closed.
  const dedupedPositions: [number, number, number][] = [];
  const indexMap = new Map<string, number>();
  const remap: number[] = new Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * unitScale;
    const y = positions[i + 1] * unitScale;
    const z = positions[i + 2] * unitScale;
    const key = `${x.toFixed(6)}_${y.toFixed(6)}_${z.toFixed(6)}`;
    let dedupId = indexMap.get(key);
    if (dedupId === undefined) {
      dedupId = dedupedPositions.length;
      dedupedPositions.push([x, y, z]);
      indexMap.set(key, dedupId);
    }
    remap[i / 3] = dedupId;
  }

  // Remap triangles to deduped indices; drop degenerates. Two cases:
  // (a) corners snapped to the same vertex, (b) three distinct vertices
  // but colinear (zero-area). Both must be filtered HERE — emitting a
  // degenerate triangle later leaves orphan ORIENTED_EDGE/EDGE_LOOP
  // entities in the file and risks a zero-length EDGE_CURVE direction.
  const tris: [number, number, number][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    const pa = dedupedPositions[a];
    const pb = dedupedPositions[b];
    const pc = dedupedPositions[c];
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx === 0 && ny === 0 && nz === 0) continue;
    tris.push([a, b, c]);
  }
  if (tris.length === 0) return null;

  // 2. CARTESIAN_POINT + VERTEX_POINT per unique vertex.
  const cartesianPointId: number[] = new Array(dedupedPositions.length);
  const vertexPointId: number[] = new Array(dedupedPositions.length);
  for (let v = 0; v < dedupedPositions.length; v++) {
    const [x, y, z] = dedupedPositions[v];
    const cp = newId();
    lines.push(
      `#${cp} = CARTESIAN_POINT('',(${stepNum(x)},${stepNum(y)},${stepNum(z)}));`,
    );
    cartesianPointId[v] = cp;
    const vp = newId();
    lines.push(`#${vp} = VERTEX_POINT('',#${cp});`);
    vertexPointId[v] = vp;
  }

  // 3. EDGE_CURVE per unique undirected edge (lazy). Key sorted vertex
  //    pair; ORIENTED_EDGE flips orientation when walked backward.
  const edgeCurveByKey = new Map<string, number>();
  const getEdgeCurve = (
    va: number,
    vb: number,
  ): { id: number; orientation: boolean } => {
    const start = Math.min(va, vb);
    const end = Math.max(va, vb);
    const key = `${start}_${end}`;
    let id = edgeCurveByKey.get(key);
    if (id === undefined) {
      const [sx, sy, sz] = dedupedPositions[start];
      const [ex, ey, ez] = dedupedPositions[end];
      const dx = ex - sx;
      const dy = ey - sy;
      const dz = ez - sz;
      const len = Math.hypot(dx, dy, dz);
      const dir = newId();
      lines.push(
        `#${dir} = DIRECTION('',(${stepNum(dx / len)},${stepNum(dy / len)},${stepNum(dz / len)}));`,
      );
      const vec = newId();
      lines.push(`#${vec} = VECTOR('',#${dir},${stepNum(len)});`);
      const line = newId();
      lines.push(`#${line} = LINE('',#${cartesianPointId[start]},#${vec});`);
      id = newId();
      lines.push(
        `#${id} = EDGE_CURVE('',#${vertexPointId[start]},#${vertexPointId[end]},#${line},.T.);`,
      );
      edgeCurveByKey.set(key, id);
    }
    return { id, orientation: va === start };
  };

  // 4. ADVANCED_FACE per triangle.
  const faceIds: number[] = [];
  for (const [v0, v1, v2] of tris) {
    const e01 = getEdgeCurve(v0, v1);
    const e12 = getEdgeCurve(v1, v2);
    const e20 = getEdgeCurve(v2, v0);

    const oe01 = newId();
    lines.push(
      `#${oe01} = ORIENTED_EDGE('',*,*,#${e01.id},${e01.orientation ? ".T." : ".F."});`,
    );
    const oe12 = newId();
    lines.push(
      `#${oe12} = ORIENTED_EDGE('',*,*,#${e12.id},${e12.orientation ? ".T." : ".F."});`,
    );
    const oe20 = newId();
    lines.push(
      `#${oe20} = ORIENTED_EDGE('',*,*,#${e20.id},${e20.orientation ? ".T." : ".F."});`,
    );

    const loop = newId();
    lines.push(`#${loop} = EDGE_LOOP('',(#${oe01},#${oe12},#${oe20}));`);
    const bound = newId();
    lines.push(`#${bound} = FACE_OUTER_BOUND('',#${loop},.T.);`);

    // Plane: origin = v0, axis = triangle normal, ref_dir = edge v0→v1.
    const p0 = dedupedPositions[v0];
    const p1 = dedupedPositions[v1];
    const p2 = dedupedPositions[v2];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    // Degenerate triangles were filtered before this loop, so nlen > 0.
    const nlen = Math.hypot(nx, ny, nz);
    nx /= nlen; ny /= nlen; nz /= nlen;
    const alen = Math.hypot(ax, ay, az);
    const rx = ax / alen, ry = ay / alen, rz = az / alen;

    const normalDir = newId();
    lines.push(
      `#${normalDir} = DIRECTION('',(${stepNum(nx)},${stepNum(ny)},${stepNum(nz)}));`,
    );
    const refDir = newId();
    lines.push(
      `#${refDir} = DIRECTION('',(${stepNum(rx)},${stepNum(ry)},${stepNum(rz)}));`,
    );
    const axis = newId();
    lines.push(
      `#${axis} = AXIS2_PLACEMENT_3D('',#${cartesianPointId[v0]},#${normalDir},#${refDir});`,
    );
    const plane = newId();
    lines.push(`#${plane} = PLANE('',#${axis});`);

    const face = newId();
    lines.push(
      `#${face} = ADVANCED_FACE('',(#${bound}),#${plane},.T.);`,
    );
    faceIds.push(face);
  }

  if (faceIds.length === 0) return null;

  const shellId = newId();
  lines.push(
    `#${shellId} = CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(",")}));`,
  );
  const solidId = newId();
  lines.push(`#${solidId} = MANIFOLD_SOLID_BREP('${bodyName}',#${shellId});`);
  return solidId;
}

/** STEP numeric format — short decimals with explicit decimal point. */
function stepNum(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  const s = n.toFixed(8);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".");
}
