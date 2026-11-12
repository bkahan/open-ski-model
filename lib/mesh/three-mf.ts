// Writes a 3MF with one solid per filament, packed as a single assembly
// so a slicer loads it as one model with colored parts. Filament numbers
// live in Metadata/model_settings.config, which Bambu Studio and Orca
// read; basematerials carries the same colors for everything else.
//
// Bambu Studio sorts a 3MF by its Application metadata: a value starting
// "BambuStudio-" makes it a Bambu file (bbs_3mf.cpp, _handle_end_metadata),
// anything else a third-party one. A third-party file is loaded as
// geometry, and where Studio can read colors from it, it drops the file's
// own filament numbers in favor of its color import (Plater.cpp,
// load_files). A Bambu file keeps the numbers in model_settings.config.
// So the file carries that mark.
//
// There is no project_settings.config on purpose. In a marked file Studio
// would load it as the project's settings, over bare defaults for every
// key the file lacks, in place of the user's presets. Without one it
// loads geometry and filament numbers and leaves the presets alone. The
// cost: opened as a project, Studio does not add filaments to its list,
// so the user needs as many there as the model has colors.
//
// A 3MF is a zip, so a small writer lives here rather than a dependency.

const MM_PER_INCH = 25.4;

export interface ThreeMfPart {
  name: string;
  /** Filament number, starting at 1. */
  filament: number;
  /** Model space: x east, y up, z north, inches. */
  positions: ArrayLike<number>;
  /** Vertex stride in `positions`. */
  positionStride: number;
  triangles: ArrayLike<number>;
}

export interface ThreeMfFilament {
  name: string;
  hex: string;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatMm(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

function meshXml(part: ThreeMfPart, chunks: string[]): void {
  chunks.push("<mesh><vertices>");
  const { positions, positionStride: stride, triangles } = part;
  for (let i = 0; i + 2 < positions.length; i += stride) {
    // x east, y north, z up: the model's own axes reordered.
    const x = formatMm(positions[i] * MM_PER_INCH);
    const y = formatMm(positions[i + 2] * MM_PER_INCH);
    const z = formatMm(positions[i + 1] * MM_PER_INCH);
    chunks.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
  }
  chunks.push("</vertices><triangles>");
  // Reordering the axes mirrors the winding, so each triangle is reversed.
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    chunks.push(`<triangle v1="${triangles[t]}" v2="${triangles[t + 2]}" v3="${triangles[t + 1]}"/>`);
  }
  chunks.push("</triangles></mesh>");
}

/**
 * The Bambu Studio release the file claims to come from. Old enough that
 * no current install calls it newer than itself and asks for an update.
 */
const BAMBU_APPLICATION = "BambuStudio-01.10.02.76";
/** Bambu's own 3MF layout version: parts as component objects, settings in model_settings.config. */
const BAMBU_3MF_VERSION = "1";

const MATERIALS_ID = 1;
const firstPartId = MATERIALS_ID + 1;

function modelXml(title: string, parts: ThreeMfPart[], filaments: ThreeMfFilament[]): string {
  const assemblyId = firstPartId + parts.length;
  const chunks: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    `<metadata name="Application">${BAMBU_APPLICATION}</metadata>`,
    `<metadata name="BambuStudio:3mfVersion">${BAMBU_3MF_VERSION}</metadata>`,
    `<metadata name="Title">${escapeXml(title)}</metadata>`,
    "<resources>",
    `<basematerials id="${MATERIALS_ID}">`,
  ];
  for (const filament of filaments) {
    chunks.push(`<base name="${escapeXml(filament.name)}" displaycolor="${filament.hex}FF"/>`);
  }
  chunks.push("</basematerials>");
  parts.forEach((part, i) => {
    chunks.push(
      `<object id="${firstPartId + i}" type="model" name="${escapeXml(part.name)}" pid="${MATERIALS_ID}" pindex="${part.filament - 1}">`,
    );
    meshXml(part, chunks);
    chunks.push("</object>");
  });
  chunks.push(`<object id="${assemblyId}" type="model" name="${escapeXml(title)}"><components>`);
  parts.forEach((_, i) => chunks.push(`<component objectid="${firstPartId + i}"/>`));
  chunks.push(`</components></object></resources><build><item objectid="${assemblyId}"/></build></model>`);
  return chunks.join("");
}

function modelSettingsXml(title: string, parts: ThreeMfPart[]): string {
  const assemblyId = firstPartId + parts.length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    `  <object id="${assemblyId}">`,
    `    <metadata key="name" value="${escapeXml(title)}"/>`,
    '    <metadata key="extruder" value="1"/>',
  ];
  parts.forEach((part, i) => {
    lines.push(
      `    <part id="${firstPartId + i}" subtype="normal_part">`,
      `      <metadata key="name" value="${escapeXml(part.name)}"/>`,
      `      <metadata key="extruder" value="${part.filament}"/>`,
      "    </part>",
    );
  });
  lines.push("  </object>", "</config>");
  return lines.join("\n");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflated(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
/** January 1, 1980: the earliest valid DOS date, as zip has no "unset". */
const ZIP_DOS_DATE = 0x21;

function zipHeader(signature: number, size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

async function zipArchive(files: Array<[string, string]>): Promise<Blob> {
  const encoder = new TextEncoder();
  const body: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  let directorySize = 0;

  for (const [path, text] of files) {
    const name = encoder.encode(path);
    const raw = encoder.encode(text);
    const data = await deflated(raw);
    const crc = crc32(raw);

    const local = zipHeader(0x04034b50, 30);
    local.view.setUint16(4, ZIP_VERSION, true);
    local.view.setUint16(8, DEFLATE_METHOD, true);
    local.view.setUint16(12, ZIP_DOS_DATE, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, raw.length, true);
    local.view.setUint16(26, name.length, true);
    body.push(local.bytes as BlobPart, name as BlobPart, data as BlobPart);

    const central = zipHeader(0x02014b50, 46);
    central.view.setUint16(4, ZIP_VERSION, true);
    central.view.setUint16(6, ZIP_VERSION, true);
    central.view.setUint16(10, DEFLATE_METHOD, true);
    central.view.setUint16(14, ZIP_DOS_DATE, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, raw.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes as BlobPart, name as BlobPart);

    offset += 30 + name.length + data.length;
    directorySize += 46 + name.length;
  }

  const end = zipHeader(0x06054b50, 22);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...body, ...directory, end.bytes as BlobPart], { type: "model/3mf" });
}

/** A complete .3mf for these parts. Every part's filament must be in `filaments`. */
export function buildThreeMf(
  title: string,
  parts: ThreeMfPart[],
  filaments: ThreeMfFilament[],
): Promise<Blob> {
  return zipArchive([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["3D/3dmodel.model", modelXml(title, parts, filaments)],
    ["Metadata/model_settings.config", modelSettingsXml(title, parts)],
  ]);
}
