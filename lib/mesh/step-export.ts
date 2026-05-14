// STEP (ISO 10303-21) exporter.
//
// Emits a faceted B-rep solid: each input triangle becomes a planar
// ADVANCED_FACE bounded by a 3-edge loop. Adjacent triangles share
// VERTEX_POINT and EDGE_CURVE entities (vertex deduplication by exact
// XYZ position), so the resulting MANIFOLD_SOLID_BREP is a single
// topologically watertight solid that CAD apps (Fusion 360, SolidWorks,
// FreeCAD, etc.) open as one selectable object — unlike STL, which is
// just a triangle soup with no topology.
//
// Tradeoffs:
//   - The mesh stays tessellated (no NURBS surface fitting). For our
//     terrain that's appropriate — there's no analytic surface to fit.
//   - File size is larger than STL: ~10–30 entities per triangle, plus
//     shared vertex / edge entities. A 130 K-triangle terrain produces
//     roughly a 15–25 MB STEP file. That's normal for B-rep exports of
//     dense meshes.
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
}

/**
 * Convert a triangle mesh to a STEP file. Returns the file as a single
 * string. Triangles are deduplicated by vertex position so the result
 * is a single solid, not many disconnected faces.
 */
export function exportToStep(
  data: StepMeshInput,
  opts: StepExportOptions = {},
): string {
  const name = (opts.name ?? "ski-model").replace(/'/g, "");
  const unitScale = opts.unitScale ?? 25.4;

  const positions = data.positions;
  const indices = data.indices;
  if (!positions || !indices) {
    throw new Error("STEP input missing positions or indices");
  }

  // --- 1. Dedup vertices by exact position ---
  // We use a string key with 6 decimal digits of precision. At our
  // typical scale (inches → mm, model fits in a few hundred mm) this
  // is well below the printer / CAD tolerance.
  const vertexMap = new Map<string, number>();
  const dedupedPositions: Array<[number, number, number]> = [];
  const indexRemap = new Int32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3] * unitScale;
    const y = positions[i * 3 + 1] * unitScale;
    const z = positions[i * 3 + 2] * unitScale;
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    let id = vertexMap.get(key);
    if (id === undefined) {
      id = dedupedPositions.length;
      vertexMap.set(key, id);
      dedupedPositions.push([x, y, z]);
    }
    indexRemap[i] = id;
  }

  // --- 2. Walk triangles; collect unique edges by canonical key ---
  const triCount = indices.length / 3;
  type RemappedTri = [number, number, number];
  const tris: RemappedTri[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = indexRemap[indices[t * 3]];
    const b = indexRemap[indices[t * 3 + 1]];
    const c = indexRemap[indices[t * 3 + 2]];
    // Skip degenerate triangles (duplicate vertex after dedup, or
    // collinear). These don't contribute to the boundary and would
    // confuse downstream CAD readers.
    if (a === b || b === c || a === c) continue;
    tris.push([a, b, c]);
  }

  // --- 3. Build the STEP file ---
  const lines: string[] = [];
  let nextId = 1;
  const newId = () => nextId++;

  // 3a. CARTESIAN_POINT + VERTEX_POINT per deduped vertex.
  const cartesianPointId = new Int32Array(dedupedPositions.length);
  const vertexPointId = new Int32Array(dedupedPositions.length);
  for (let i = 0; i < dedupedPositions.length; i++) {
    const [x, y, z] = dedupedPositions[i];
    const cp = newId();
    cartesianPointId[i] = cp;
    lines.push(
      `#${cp} = CARTESIAN_POINT('',(${stepNum(x)},${stepNum(y)},${stepNum(z)}));`,
    );
    const vp = newId();
    vertexPointId[i] = vp;
    lines.push(`#${vp} = VERTEX_POINT('',#${cp});`);
  }

  // 3b. EDGE_CURVE per unique undirected edge (emitted lazily).
  // Key = "smallerVid_largerVid". The edge is parameterized from the
  // smaller vertex id to the larger one; ORIENTED_EDGE consumers flip
  // orientation when they walk it the other way.
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

  // 3c. ADVANCED_FACE per triangle.
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

    // Plane: AXIS2_PLACEMENT_3D with origin = v0, axis = triangle
    // normal, ref_dir = edge v0→v1.
    const p0 = dedupedPositions[v0];
    const p1 = dedupedPositions[v1];
    const p2 = dedupedPositions[v2];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    let nlen = Math.hypot(nx, ny, nz);
    if (nlen === 0) continue; // collinear; skip
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

  // 3d. Shell + solid.
  const shellId = newId();
  lines.push(
    `#${shellId} = CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(",")}));`,
  );
  const solidId = newId();
  lines.push(`#${solidId} = MANIFOLD_SOLID_BREP('${name}',#${shellId});`);

  // 3e. Coordinate system + product / context boilerplate. AP203 expects
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
  lines.push(
    `#${shapeRep} = ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(#${worldAxis},#${solidId}),#${geomContext});`,
  );

  const appContext = newId();
  lines.push(
    `#${appContext} = APPLICATION_CONTEXT('configuration controlled 3D designs of mechanical parts and assemblies');`,
  );
  const appProtocol = newId();
  lines.push(
    `#${appProtocol} = APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,#${appContext});`,
  );
  const productContext = newId();
  lines.push(
    `#${productContext} = PRODUCT_CONTEXT('',#${appContext},'mechanical');`,
  );
  const product = newId();
  lines.push(
    `#${product} = PRODUCT('${name}','${name}','',(#${productContext}));`,
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
  const shapeDefRep = newId();
  lines.push(
    `#${shapeDefRep} = SHAPE_DEFINITION_REPRESENTATION(#${productDefShape},#${shapeRep});`,
  );

  // --- 4. Assemble final file ---
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "");
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Open Ski Model export'),'2;1');",
    `FILE_NAME('${name}.step','${ts}',(''),(''),'Open Ski Model','','');`,
    "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    "ENDSEC;",
    "DATA;",
  ].join("\n");
  const footer = ["ENDSEC;", "END-ISO-10303-21;", ""].join("\n");

  return header + "\n" + lines.join("\n") + "\n" + footer;
}

/** STEP numeric format — short decimals with explicit decimal point. */
function stepNum(n: number): string {
  // STEP rejects 1e-7 style; use plain decimals. Trim trailing zeros
  // but keep at least one decimal so the parser sees a REAL.
  if (!Number.isFinite(n)) return "0.";
  const s = n.toFixed(8);
  // Strip trailing zeros after the decimal point, but leave at least
  // one digit so "1.00000000" → "1.".
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".");
}
