import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { buildThreeMf, type ThreeMfPart } from "./three-mf";

const tetra = (filament: number, name: string): ThreeMfPart => ({
  name,
  filament,
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  positionStride: 3,
  triangles: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2],
});

async function unzip(blob: Blob): Promise<Map<string, string>> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const files = new Map<string, string>();
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const local = buf.readUInt32LE(at + 42);
    const localName = buf.readUInt16LE(local + 26);
    const start = local + 30 + localName;
    const compressed = buf.subarray(start, start + buf.readUInt32LE(at + 20));
    files.set(name, inflateRawSync(compressed).toString("utf8"));
    at += 46 + nameLength;
  }
  return files;
}

const filaments = [
  { name: "White", hex: "#FFFFFF" },
  { name: "Black & Co", hex: "#111827" },
];

describe("buildThreeMf", () => {
  it("packs a readable package with the expected files", async () => {
    const files = await unzip(await buildThreeMf("Jay Peak", [tetra(1, "White"), tetra(2, "Black & Co")], filaments));
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "3D/3dmodel.model",
      "Metadata/model_settings.config",
    ]);
  });

  it("marks the file the way Bambu Studio needs before it will read the filament numbers", async () => {
    const model = (await unzip(await buildThreeMf("T", [tetra(1, "White")], filaments))).get("3D/3dmodel.model")!;
    // Studio's reader tests for this prefix and parses what follows as a version.
    expect(model).toMatch(/<metadata name="Application">BambuStudio-\d{2}\.\d{2}\.\d{2}\.\d{2}<\/metadata>/);
    expect(model).toContain('<metadata name="BambuStudio:3mfVersion">1</metadata>');
    expect(model).toContain('xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"');
    // Metadata comes before the resources it describes.
    expect(model.indexOf('name="Application"')).toBeLessThan(model.indexOf("<resources>"));
  });

  it("leaves the user's printer and filament presets alone", async () => {
    const files = await unzip(await buildThreeMf("T", [tetra(1, "White"), tetra(2, "Black & Co")], filaments));
    expect(files.has("Metadata/project_settings.config")).toBe(false);
  });

  it("makes one assembly and escapes names", async () => {
    const model = (await unzip(await buildThreeMf("A<B", [tetra(1, "White"), tetra(2, "Black & Co")], filaments))).get("3D/3dmodel.model")!;
    expect(model).toContain('<component objectid="2"/><component objectid="3"/>');
    expect(model).toContain('<build><item objectid="4"/></build>');
    expect(model).toContain("A&#60;B");
    expect(model).toContain('displaycolor="#FFFFFFFF"');
    expect(model).toContain('pindex="1"');
  });

  it("converts to millimeters, z up and north along +y, with winding fixed", async () => {
    const part = { ...tetra(1, "White"), positions: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0], triangles: [0, 1, 2] };
    const model = (await unzip(await buildThreeMf("T", [part], filaments))).get("3D/3dmodel.model")!;
    expect(model).toContain('<vertex x="25.4" y="76.2" z="50.8"/>');
    expect(model).toContain('<triangle v1="0" v2="2" v3="1"/>');
  });

  it("assigns each part its filament for the slicer", async () => {
    const files = await unzip(await buildThreeMf("T", [tetra(1, "White"), tetra(2, "Black & Co")], filaments));
    const settings = files.get("Metadata/model_settings.config")!;
    expect(settings).toContain('<object id="4">');
    expect(settings).toContain('<part id="3" subtype="normal_part">');
    expect(settings).toContain('<metadata key="extruder" value="2"/>');
  });

  it("honors the vertex stride", async () => {
    const part = { ...tetra(1, "White"), positions: [1, 0, 0, 9, 9, 2, 0, 0, 9, 9], positionStride: 5, triangles: [] };
    const model = (await unzip(await buildThreeMf("T", [part], filaments))).get("3D/3dmodel.model")!;
    expect(model.match(/<vertex /g)).toHaveLength(2);
  });
});
