export type Lux3dKind = 'imgTo3d' | 'textTo3d' | 'partSplit' | 'articulate' | 'rig' | 'retarget' | 'export';

export interface Lux3dOutputs {
  zip?: string;
  glb?: string;
  ply?: string;
  url?: string;
  usdz?: string;
  stl?: string;
  '3mf'?: string;
  obj?: string;
  fbx?: string;
  actions?: Record<string, string>;
  failed?: string[];
  error?: string;
}

const present = (c: string | null | undefined): c is string => !!c && c !== 'NOT_REQUESTED';

function errorOf(content: string): string | undefined {
  if (!content.trim().startsWith('{')) return undefined;
  try {
    const j = JSON.parse(content) as { error?: { code?: string; message?: string } };
    return j.error ? `${j.error.code ?? 'ERROR'}: ${j.error.message ?? ''}`.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Interprets `outputs[].content` of a finished Lux3D task, by task kind (order is defined per kind by the API). */
export function parseLux3dOutputs(kind: Lux3dKind, outputs: { content: string | null }[]): Lux3dOutputs {
  const contents = outputs.map((o) => o.content);
  const first = contents[0];
  if (present(first)) {
    const err = errorOf(first);
    if (err && kind !== 'retarget') return { error: err };
  }
  const out: Lux3dOutputs = {};
  if (kind === 'retarget') {
    if (!present(first)) return { error: 'empty retarget result' };
    const j = JSON.parse(first) as { actions?: { animation_id: string; status: string; animationGlbUrl?: string; fbxUrl?: string }[] };
    out.actions = {};
    out.failed = [];
    for (const a of j.actions ?? []) {
      const url = a.animationGlbUrl ?? a.fbxUrl;
      if (a.status === 'success' && url) out.actions[a.animation_id] = url;
      else out.failed.push(a.animation_id);
    }
    return out;
  }
  if (kind === 'export') {
    const order = ['zip', 'glb', 'usdz', 'obj', 'fbx', 'stl', '3mf'] as const;
    order.forEach((k, i) => {
      const c = contents[i];
      if (present(c)) out[k] = c;
    });
    return out;
  }
  for (const c of contents) {
    if (!present(c)) continue;
    const ext = c.split('?')[0]!.toLowerCase();
    if (ext.endsWith('.zip')) out.zip ??= c;
    else if (ext.endsWith('.glb')) out.glb ??= c;
    else if (ext.endsWith('.ply')) out.ply ??= c;
    else out.url ??= c;
  }
  return out;
}
