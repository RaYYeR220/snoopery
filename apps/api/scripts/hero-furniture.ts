// Samples coloured points from real published Lux3D objects for the landing hero, so the furniture that opens there
// is the actual generated model on its actual joints. Writes apps/web/public/hero/furniture.json.
//   tsx scripts/hero-furniture.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const BASE = 'https://storage.googleapis.com/snoopery-assets';
// Which object stands in for which hero piece, and which of its parts the example room opens.
const PICK = [
  { id: 'IvFhxMBVoB', part: 'drawer', density: 1300 },
  { id: 'AFBzGii6wW', part: 'lid', density: 5500 },
  { id: 'Sm_9Y1KRzF', part: 'drawer_middle', density: 280 },
  { id: 'mWlggo9rv5', part: 'door_left', density: 340 },
];

type M4 = number[];
const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
const apply = (m: M4, x: number, y: number, z: number) => [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const out = [];
for (const pick of PICK) {
  const doc = await (await fetch(`${BASE}/docs/objects/${pick.id}.json`)).json();
  const glb = new Uint8Array(await (await fetch(doc.webGlb)).arrayBuffer());
  const gltf = await io.readBinary(glb);
  const joints = doc.joints as { part: string; type: string; axis: number[]; pivot: number[]; min: number; max: number }[];
  const partNames = new Set(joints.map((j) => j.part));
  const textures = new Map<unknown, { w: number; h: number; px: Buffer }>();
  const pts: number[] = [];
  const prims: { prim: Primitive; m: M4; part: string | null }[] = [];
  const collect = (node: Node, parent: M4, part: string | null) => {
    const world = mul(parent, node.getMatrix() as unknown as M4);
    const here = partNames.has(node.getName()) ? node.getName() : part;
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) prims.push({ prim, m: world, part: here });
    for (const c of node.listChildren()) collect(c, world, here);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of gltf.getRoot().getDefaultScene()!.listChildren()) collect(root, I, null);

  for (const { prim, m, part } of prims) {
    const pos = prim.getAttribute('POSITION')!;
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const tex = prim.getMaterial()?.getBaseColorTexture() ?? null;
    const factor = prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
    let img: { w: number; h: number; px: Buffer } | null = null;
    if (tex) {
      img = textures.get(tex) ?? null;
      if (!img) {
        const { data, info } = await sharp(Buffer.from(tex.getImage()!)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        img = { w: info.width, h: info.height, px: data };
        textures.set(tex, img);
      }
    }
    const n = idx ? idx.getCount() / 3 : pos.getCount() / 3;
    const v = (i: number) => apply(m, ...(pos.getElement(i, [0, 0, 0]) as [number, number, number]));
    for (let t = 0; t < n; t++) {
      const [a, b, c] = idx ? [idx.getScalar(t * 3), idx.getScalar(t * 3 + 1), idx.getScalar(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
      const A = v(a);
      const B = v(b);
      const C = v(c);
      const ab = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!];
      const ac = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
      const area = 0.5 * Math.hypot(ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!);
      let k = area * pick.density;
      while (k > 0) {
        if (k < 1 && rand() > k) break;
        k -= 1;
        let s = rand();
        let r = rand();
        if (s + r > 1) [s, r] = [1 - s, 1 - r];
        const p = [A[0]! + ab[0]! * s + ac[0]! * r, A[1]! + ab[1]! * s + ac[1]! * r, A[2]! + ab[2]! * s + ac[2]! * r];
        let col = [200, 200, 200];
        if (img && uv) {
          const ua = uv.getElement(a, [0, 0]);
          const ub = uv.getElement(b, [0, 0]);
          const uc = uv.getElement(c, [0, 0]);
          const u = ua[0]! + (ub[0]! - ua[0]!) * s + (uc[0]! - ua[0]!) * r;
          const w = ua[1]! + (ub[1]! - ua[1]!) * s + (uc[1]! - ua[1]!) * r;
          const x = Math.min(img.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * img.w)));
          const y = Math.min(img.h - 1, Math.max(0, Math.floor((w - Math.floor(w)) * img.h)));
          const o = (y * img.w + x) * 3;
          col = [img.px[o]!, img.px[o + 1]!, img.px[o + 2]!];
        }
        pts.push(+p[0]!.toFixed(3), +p[1]!.toFixed(3), +p[2]!.toFixed(3), part === pick.part ? 1 : 0, Math.round(col[0]! * factor[0]!), Math.round(col[1]! * factor[1]!), Math.round(col[2]! * factor[2]!));
      }
    }
  }
  const j = joints.find((x) => x.part === pick.part)!;
  const [w, h, d] = doc.card.sizeM as number[];
  out.push({ id: pick.id, label: doc.label, size: [w, h, d], part: pick.part, joint: { type: j.type, axis: j.axis, pivot: j.pivot, max: j.max }, points: pts });
  console.log(pick.id, doc.label, pts.length / 7, 'points');
}
writeFileSync(join(import.meta.dirname, '..', '..', 'web', 'public', 'hero', 'furniture.json'), JSON.stringify(out));
