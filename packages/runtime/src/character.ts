import { Animation, Box3, GLTFLoader, Object3D, Vector3, downloadTexture } from '@manycore/aholo-viewer';

export type ClipRole = 'idle' | 'walk' | 'open' | 'pickup' | 'cheer';

export interface CharacterSpec {
  modelUrl: string;
  /** Extra GLBs, each carrying one retargeted motion for the same skeleton (Lux3D retarget, "separate" mode). */
  clipUrls?: Partial<Record<ClipRole, string>>;
  heightM?: number;
}

type Action = InstanceType<typeof Animation.AnimationAction>;
type Clip = Animation.AnimationClip;

const FADE = 0.2;
const NAME_HINTS: Record<ClipRole, string[]> = {
  idle: ['idle'],
  walk: ['walk', 'run'],
  open: ['chest_open', 'interact', 'open'],
  pickup: ['pickup', 'pick'],
  cheer: ['dance', 'yes', 'cheer'],
};

async function loadGlb(url: string) {
  const buf = await (await fetch(url)).arrayBuffer();
  return GLTFLoader.loadGLTF(buf, { textureLoader: downloadTexture as never });
}

/** A rigged figure that walks the room and acts out a solution. */
export class Character {
  readonly root = new Object3D();
  private mixer: InstanceType<typeof Animation.AnimationMixer> | null = null;
  private actions: Partial<Record<ClipRole, Action>> = {};
  private current: Action | null = null;
  private fades: { action: Action; from: number; to: number; t: number }[] = [];
  private walk: { from: Vector3; to: Vector3; t: number; dur: number; done: () => void } | null = null;
  private yaw = 0;

  constructor(private readonly plugin: InstanceType<typeof Animation.AnimationPlugin>) {}

  async load(spec: CharacterSpec) {
    const res = await loadGlb(spec.modelUrl);
    const model = res.scene as unknown as Object3D;
    this.mixer = new Animation.AnimationMixer(model);
    this.plugin.add(this.mixer);
    const bound = new WeakSet<object>();
    res.skeletons.forEach((meshes: any, sk: any) => {
      const skeleton = new Animation.Skeleton(sk.bones, sk.inverseBindMatrices);
      meshes.forEach((m: any) => {
        if (bound.has(m)) return;
        bound.add(m);
        this.plugin.bindSkinned(m, skeleton, this.mixer as never);
      });
    });
    // Normalise height so any generated character fits the room. Skinned meshes need their bone-aware
    // world bounds (after binding the skeleton); plain meshes use their geometry bounds.
    const bounds = () => {
      model.updateMatrixWorld(true);
      const box = new Box3();
      let found = false;
      model.traverse((o: Object3D) => {
        const sm = o as unknown as { isSkinnedMesh?: boolean; update?: () => void; worldBoundingBox?: InstanceType<typeof Box3> };
        if (sm.isSkinnedMesh && sm.update && sm.worldBoundingBox) {
          sm.update();
          const wb = sm.worldBoundingBox;
          if (!wb.isEmpty() && wb.max.y - wb.min.y > 1e-9) {
            if (found) box.union(wb);
            else box.copy(wb);
            found = true;
          }
        }
      });
      return found ? box : new Box3().setFromObject(model as never);
    };
    const before = bounds();
    const s = (spec.heightM ?? 1.6) / Math.max(1e-6, before.max.y - before.min.y);
    model.scale.setScalar(s);
    const after = bounds();
    model.position.x -= (after.min.x + after.max.x) / 2;
    model.position.y -= after.min.y;
    model.position.z -= (after.min.z + after.max.z) / 2;
    this.root.add(model);

    const clips: Clip[] = [...((res.animations ?? []) as Clip[])];
    for (const [, url] of Object.entries(spec.clipUrls ?? {})) {
      if (!url) continue;
      try {
        clips.push(...(((await loadGlb(url)).animations ?? []) as Clip[]));
      } catch {
        /* a missing motion just falls back to idle */
      }
    }
    for (const role of Object.keys(NAME_HINTS) as ClipRole[]) {
      const clip = clips.find((c) => NAME_HINTS[role].some((n) => c.name.toLowerCase().includes(n)));
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.active = false;
      action.weight = 0;
      this.actions[role] = action;
    }
    this.play('idle', 0);
  }

  has(role: ClipRole) {
    return !!this.actions[role];
  }

  play(role: ClipRole, fade = FADE) {
    const next = this.actions[role] ?? this.actions.idle ?? null;
    if (!next || next === this.current) return;
    if (this.current) this.fades.push({ action: this.current, from: this.current.weight, to: 0, t: fade > 0 ? 0 : 1 });
    next.reset();
    next.active = true;
    this.fades.push({ action: next, from: 0, to: 1, t: fade > 0 ? 0 : 1 });
    this.current = next;
    if (fade <= 0) {
      next.weight = 1;
    }
  }

  place(x: number, y: number, z: number, yaw = this.yaw) {
    this.root.position.set(x, y, z);
    this.yaw = yaw;
    this.root.rotation.y = yaw;
    this.root.setMatrixDirty();
    this.root.updateMatrixWorld(true);
  }

  position(): [number, number, number] {
    return [this.root.position.x, this.root.position.y, this.root.position.z];
  }

  face(x: number, z: number) {
    const p = this.root.position;
    this.yaw = Math.atan2(x - p.x, z - p.z);
    this.root.rotation.y = this.yaw;
    this.root.setMatrixDirty();
  }

  walkTo(x: number, z: number, speed = 1.1): Promise<void> {
    const from = this.root.position.clone();
    const to = new Vector3(x, from.y, z);
    const dist = from.distanceTo(to);
    if (dist < 0.05) return Promise.resolve();
    this.face(x, z);
    this.play('walk');
    return new Promise((done) => {
      this.walk = { from, to, t: 0, dur: dist / speed, done };
    });
  }

  /** Advances walking and cross-fades; returns true while anything is moving. */
  update(dt: number): boolean {
    let moving = false;
    if (this.walk) {
      const w = this.walk;
      w.t = Math.min(1, w.t + dt / w.dur);
      const p = w.from.clone().lerp(w.to, w.t);
      this.root.position.set(p.x, p.y, p.z);
      this.root.setMatrixDirty();
      if (w.t >= 1) {
        this.walk = null;
        this.play('idle');
        w.done();
      }
      moving = true;
    }
    for (const f of this.fades) {
      f.t = Math.min(1, f.t + dt / FADE);
      f.action.weight = f.from + (f.to - f.from) * f.t;
      if (f.t >= 1 && f.to === 0) f.action.active = false;
    }
    this.fades = this.fades.filter((f) => f.t < 1);
    return moving || this.fades.length > 0 || !!this.current;
  }
}
