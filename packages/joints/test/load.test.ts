import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { NodeIO } from '@gltf-transform/core';
import type { Document } from '@gltf-transform/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describeModel } from '../src/describe.ts';
import { extractJoints } from '../src/extract.ts';
import { loadModel, readModel, readZip } from '../src/load.ts';
import { drawerOnSlide } from './fixtures.ts';

interface Entry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
}

function zip(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

function patchGlbJson(glb: Uint8Array, edit: (json: Record<string, unknown>) => void): Uint8Array {
  const buf = Buffer.from(glb);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as Record<string, unknown>;
  edit(json);
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const rest = buf.subarray(20 + jsonLength);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([head, text, rest]));
}

const io = new NodeIO();

function attachBuffer(doc: Document): void {
  const buffer = doc.createBuffer('data');
  for (const accessor of doc.getRoot().listAccessors()) accessor.setBuffer(buffer);
}
const scratch = mkdtempSync(join(tmpdir(), 'joints-load-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('readZip', () => {
  it('reads stored and deflated entries', () => {
    const text = new TextEncoder().encode('hello hello hello hello');
    const entries = readZip(zip([
      { name: 'a.txt', data: text },
      { name: 'dir/b.txt', data: text, deflate: true },
    ]));
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe('hello hello hello hello');
  });

  it('rejects a corrupted entry', () => {
    const bytes = zip([{ name: 'a.txt', data: new TextEncoder().encode('abcdef') }]);
    const at = 31 + 'a.txt'.length;
    bytes[at] = bytes[at]! ^ 0xff;
    expect(() => readZip(bytes)).toThrow(/CRC/);
  });

  it('rejects bytes that are not a zip archive', () => {
    expect(() => readZip(new Uint8Array(64))).toThrow(/zip/i);
  });
});

describe('readModel / loadModel', () => {
  it('reads a GLB, a GLB inside a zip, a zip with a .gltf + .bin, and a directory', async () => {
    const { doc } = drawerOnSlide();
    attachBuffer(doc);
    const glb = await io.writeBinary(doc);

    const fromGlb = await readModel(glb);
    expect(extractJoints(fromGlb.doc)[0]!.max).toBeCloseTo(0.3, 5);

    const zipped = await readModel(zip([
      { name: 'preview.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'out/model.glb', data: glb, deflate: true },
    ]));
    expect(zipped.source).toBe('out/model.glb');
    expect(zipped.entries?.map((e) => e.name)).toEqual(['preview.png', 'out/model.glb']);
    expect(extractJoints(zipped.doc)).toHaveLength(1);

    const { json, resources } = await io.writeJSON(doc, { basename: 'scene' });
    const files: Entry[] = [{ name: 'pkg/scene.gltf', data: new TextEncoder().encode(JSON.stringify(json)) }];
    for (const [uri, data] of Object.entries(resources)) files.push({ name: `pkg/${uri}`, data, deflate: true });
    const fromGltfZip = await readModel(zip(files));
    expect(fromGltfZip.source).toBe('pkg/scene.gltf');
    expect(extractJoints(fromGltfZip.doc)).toHaveLength(1);

    const dir = join(scratch, 'model');
    mkdirSync(dir);
    writeFileSync(join(dir, 'drawer.glb'), glb);
    const fromDir = await loadModel(dir);
    expect(fromDir.source.endsWith('drawer.glb')).toBe(true);
    expect(extractJoints(fromDir.doc)).toHaveLength(1);

    const zipPath = join(scratch, 'out.zip');
    writeFileSync(zipPath, zip([{ name: 'model.glb', data: glb }]));
    expect(extractJoints((await loadModel(zipPath)).doc)).toHaveLength(1);
  });

  it('loads a model whose required extension is not available, with a warning', async () => {
    const { doc } = drawerOnSlide();
    attachBuffer(doc);
    const glb = patchGlbJson(await io.writeBinary(doc), (json) => {
      json.extensionsUsed = ['KHR_draco_mesh_compression'];
      json.extensionsRequired = ['KHR_draco_mesh_compression'];
    });
    const result = await readModel(glb);
    expect(result.warnings.join(' ')).toMatch(/KHR_draco_mesh_compression/);
    expect(extractJoints(result.doc)).toHaveLength(1);
  });
});

describe('describeModel', () => {
  it('lists nodes, triangle counts and animation channels', () => {
    const { doc } = drawerOnSlide();
    const d = describeModel(doc);
    expect(d.nodes.map((n) => n.name)).toEqual(['Cabinet', 'Top Drawer', 'Knob']);
    expect(d.nodes[2]!.parent).toBe('Top Drawer');
    expect(d.meshes.map((m) => m.triangles)).toEqual([12, 12, 12]);
    expect(d.triangles).toBe(36);
    expect(d.animations).toEqual([
      {
        name: 'open_drawer',
        start: 0,
        end: 1,
        duration: 1,
        channels: [{ node: 'Top Drawer', path: 'translation', interpolation: 'LINEAR', keys: 2 }],
      },
    ]);
  });
});
