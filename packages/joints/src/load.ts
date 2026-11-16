import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { NodeIO } from '@gltf-transform/core';
import type { Document, JSONDocument } from '@gltf-transform/core';

export interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

export interface LoadedModel {
  doc: Document;
  /** File (or archive entry) the document was read from. */
  source: string;
  warnings: string[];
  /** Archive listing, when the model came out of a zip. */
  entries?: { name: string; size: number }[];
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/** Reads every file of a zip archive in memory (stored or deflated entries, CRC-checked). */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip archive: end of central directory not found');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let p = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || p === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  const utf8 = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_HEADER) {
      throw new Error('Corrupt zip archive: bad central directory entry');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`Encrypted zip entry "${name}" is not supported`);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER) {
      throw new Error(`Corrupt zip archive: bad local header for "${name}"`);
    }
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    if (raw.length !== compressedSize) throw new Error(`Corrupt zip archive: "${name}" is truncated`);
    let data: Uint8Array<ArrayBuffer>;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }));
    else throw new Error(`Zip entry "${name}" uses unsupported compression method ${method}`);
    if (data.length !== size) throw new Error(`Corrupt zip archive: "${name}" has the wrong size`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in zip entry "${name}"`);
    entries.push({ name, data });
  }
  return entries;
}

/** Extensions whose data the core reader decodes without a codec, so requiring them is harmless. */
const READABLE_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength']);

async function readJSONDocument(io: NodeIO, jsonDoc: JSONDocument, warnings: string[]): Promise<Document> {
  const required = jsonDoc.json.extensionsRequired ?? [];
  const missing = required.filter((name) => !READABLE_EXTENSIONS.has(name));
  if (missing.length > 0) {
    warnings.push(`Required extensions read without their codecs (data they encode is not decoded): ${missing.join(', ')}`);
  }
  if ((jsonDoc.json.extensionsUsed ?? []).includes('EXT_meshopt_compression')) {
    warnings.push('EXT_meshopt_compression: compressed buffer views (possibly including animation) are not decoded');
  }
  if (required.length > 0) jsonDoc.json.extensionsRequired = [];
  return io.readJSON(jsonDoc);
}

const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isGlb = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46;

/** Reads a model from bytes: a GLB, a self-contained glTF JSON, or a zip holding either. */
export async function readModel(bytes: Uint8Array, name = 'model'): Promise<LoadedModel> {
  const io = new NodeIO();
  const warnings: string[] = [];
  if (isZip(bytes)) return readZipModel(io, readZip(bytes));
  const jsonDoc = isGlb(bytes)
    ? await io.binaryToJSON(bytes)
    : { json: JSON.parse(new TextDecoder().decode(bytes)) as JSONDocument['json'], resources: {} };
  return { doc: await readJSONDocument(io, jsonDoc, warnings), source: name, warnings };
}

function resolveEntryPath(base: string, uri: string): string {
  const parts: string[] = [];
  for (const segment of (base + decodeURIComponent(uri)).split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

async function readZipModel(io: NodeIO, entries: ZipEntry[]): Promise<LoadedModel> {
  const listing = entries.map((e) => ({ name: e.name, size: e.data.length }));
  const candidates = entries.filter((e) => /\.(glb|gltf)$/i.test(e.name));
  if (candidates.length === 0) {
    throw new Error(`Zip holds no .glb or .gltf file (entries: ${listing.map((e) => e.name).join(', ') || 'none'})`);
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  let chosen: LoadedModel | null = null;
  for (const entry of candidates) {
    const warnings: string[] = [];
    let jsonDoc: JSONDocument;
    if (/\.glb$/i.test(entry.name)) {
      jsonDoc = await io.binaryToJSON(entry.data);
    } else {
      const json = JSON.parse(new TextDecoder().decode(entry.data)) as JSONDocument['json'];
      const base = entry.name.includes('/') ? entry.name.slice(0, entry.name.lastIndexOf('/') + 1) : '';
      const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
      const attach = (uri: string | undefined, kind: 'buffer' | 'image'): void => {
        if (!uri || uri.startsWith('data:')) return;
        const data = byName.get(resolveEntryPath(base, uri));
        if (data) resources[uri] = data;
        else if (kind === 'buffer') throw new Error(`Zip is missing "${uri}" referenced by ${entry.name}`);
        else {
          warnings.push(`Image "${uri}" referenced by ${entry.name} is missing from the zip`);
          resources[uri] = new Uint8Array(0);
        }
      };
      for (const buffer of json.buffers ?? []) attach(buffer.uri, 'buffer');
      for (const image of json.images ?? []) attach(image.uri, 'image');
      jsonDoc = { json, resources };
    }
    const doc = await readJSONDocument(io, jsonDoc, warnings);
    const loaded: LoadedModel = { doc, source: entry.name, warnings, entries: listing };
    if (!chosen) chosen = loaded;
    if (doc.getRoot().listAnimations().length > 0) {
      chosen = loaded;
      break;
    }
  }
  if (candidates.length > 1) chosen!.warnings.push(`Zip holds ${candidates.length} models; using ${chosen!.source}`);
  return chosen!;
}

async function readModelFile(io: NodeIO, path: string): Promise<LoadedModel> {
  if (/\.zip$/i.test(path)) return { ...(await readModel(new Uint8Array(await readFile(path)), path)), source: path };
  const warnings: string[] = [];
  const jsonDoc = await io.readAsJSON(path);
  return { doc: await readJSONDocument(io, jsonDoc, warnings), source: path, warnings };
}

/**
 * Loads a model from a .glb, .gltf (external files resolved), or .zip path, or from a directory
 * holding one (the first model with animation wins; .glb before .gltf before .zip).
 */
export async function loadModel(path: string): Promise<LoadedModel> {
  const io = new NodeIO();
  if (!(await stat(path)).isDirectory()) return readModelFile(io, path);
  const names = (await readdir(path)).sort();
  const rank = (n: string): number => (/\.glb$/i.test(n) ? 0 : /\.gltf$/i.test(n) ? 1 : /\.zip$/i.test(n) ? 2 : 3);
  const candidates = names.filter((n) => rank(n) < 3).sort((a, b) => rank(a) - rank(b));
  if (candidates.length === 0) throw new Error(`No .glb, .gltf or .zip file in ${path}`);
  let chosen: LoadedModel | null = null;
  for (const name of candidates) {
    const loaded = await readModelFile(io, join(path, name));
    if (!chosen) chosen = loaded;
    if (loaded.doc.getRoot().listAnimations().length > 0) {
      chosen = loaded;
      break;
    }
  }
  if (candidates.length > 1) chosen!.warnings.push(`Directory holds ${candidates.length} models; using ${chosen!.source}`);
  return chosen!;
}
