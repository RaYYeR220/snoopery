import {
  AmbientLight,
  Animation,
  BackgroundMode,
  Box3,
  Color,
  DirectionalLight,
  Euler,
  GLTFLoader,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  SplatLoader,
  SplatState,
  SplatUtils,
  ToneMapping,
  Vector2,
  Vector3,
  createViewer,
  downloadTexture,
  setViewerConfig,
} from '@manycore/aholo-viewer';
import { jointMatrix } from '@snoopery/joints/transform';
import type { Joint, PlacedObject, RoomDoc, Vec3 } from '@snoopery/schema';
import { LookController, type Bounds, type Pose } from './controls';
import { loadVoxelCollision, type VoxelCollision } from './voxel';
import { Character, type CharacterSpec, type ClipRole } from './character';

export interface PartRef {
  objectId: string;
  part: string;
}

export interface CharacterControl {
  place(x: number, z: number, yaw?: number): void;
  walkTo(x: number, z: number): Promise<void>;
  face(x: number, z: number): void;
  play(role: ClipRole): void;
  has(role: ClipRole): boolean;
  position(): Vec3;
  show(visible: boolean): void;
}

export interface RuntimeEvents {
  onTap?: (hit: PartRef | null, floor: Vec3 | null) => void;
  onHover?: (hit: PartRef | null) => void;
  onProgress?: (fraction: number, label: string) => void;
}

export interface Runtime {
  loadRoom(doc: RoomDoc): Promise<void>;
  /** Loads only the scanned/generated space (studio). */
  loadSpace(splat: RoomDoc['splat'], spawn: RoomDoc['spawn']): Promise<void>;
  setSplatTransform(transform: number[]): void;
  addObject(o: PlacedObject): Promise<void>;
  updateObject(objectId: string, patch: Partial<Pick<PlacedObject, 'position' | 'rotationY' | 'scale' | 'cutout'>>): void;
  removeObject(objectId: string): void;
  /** World-space size of a placed object's bounding box. */
  objectSize(objectId: string): Vec3 | null;
  /** The figure that acts out a solution. Loads once; later calls reuse it. */
  character(spec: CharacterSpec): Promise<CharacterControl>;
  floorY(): number;
  /** Floor height under a point (scene collision when available). */
  groundAt(x: number, z: number): number;
  setJoint(objectId: string, part: string, t: number): void;
  getJoint(objectId: string, part: string): number;
  animateJoint(objectId: string, part: string, to: number, ms?: number): Promise<void>;
  /** Part ids present in the loaded room (objectId.part). */
  parts(): PartRef[];
  partPosition(objectId: string, part: string): Vec3 | null;
  highlight(target: PartRef | null): void;
  /** Screen position (client px) of a world point, or null when it is behind the camera. */
  project(p: Vec3): [number, number] | null;
  controls: LookController;
  pose(): Pose;
  snapshot(type?: string): string;
  dispose(): void;
}

interface PartState {
  joint: Joint;
  node: Object3D;
  rest: Matrix4;
  t: number;
  meshes: Object3D[];
}

const EYE_HEIGHT = 1.55;
const tmpM = new Matrix4();
const tmpJ = new Matrix4();

function formatOf(format: RoomDoc['splat']['format']) {
  const T = SplatLoader.SplatFileType as unknown as Record<string, number>;
  return (format === 'spz' ? T.SPZ : format === 'sog' ? T.SOG : T.PLY) as unknown as Parameters<typeof SplatLoader.parseSplatData>[0];
}

export function createRuntime(container: HTMLElement, events: RuntimeEvents = {}): Runtime {
  const viewer = createViewer('snoopery', container, {} as never);
  const camera = new PerspectiveCamera(68, container.clientWidth / Math.max(1, container.clientHeight), 0.05, 400);
  viewer.setCamera(camera);
  setViewerConfig(viewer, {
    pipeline: {
      Background: { background: { active: BackgroundMode.BasicBackground, basic: { color: new Color(0.04, 0.04, 0.045) } }, ground: { enabled: false } },
      Splatting: { enabled: true, composite: { enabled: true, highPrecisionEnabled: true, toneMapping: ToneMapping.Neutral } },
      TAA: { enabled: false },
      Highlight: { enabled: true, width: 2, borderColor: new Color(1, 0.86, 0.45), borderOpacity: 1, innerColor: new Color(1, 0.86, 0.45), innerOpacity: 0.12 },
    },
  } as never);
  const scene = viewer.getScene();

  const lights = new Object3D();
  lights.add(new AmbientLight(0xffffff, 0.85));
  const key = new DirectionalLight(0xffffff, 1.1);
  key.position.set(0.4, 1, 0.35);
  const fill = new DirectionalLight(0xffffff, 0.45);
  fill.position.set(-0.6, 0.7, -0.5);
  lights.add(key);
  lights.add(fill);
  scene.add(lights);

  const parts = new Map<string, PartState>();
  const animationPlugin = new Animation.AnimationPlugin();
  animationPlugin.registerToViewer({ viewer } as never);
  let figure: Character | null = null;
  let figureLoad: Promise<Character> | null = null;
  const objectRoots = new Map<string, Object3D>();
  const meshOwner = new Map<Object3D, PartRef>();
  let floorY = 0;
  let splatObj: Object3D | null = null;

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const pick = (cx: number, cy: number): { part: PartRef | null; floor: Vec3 | null } => {
    const r = container.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...objectRoots.values()], true).sort((a, b) => a.distance - b.distance);
    for (const h of hits) {
      let o: Object3D | null = h.object;
      while (o) {
        const ref = meshOwner.get(o);
        if (ref) return { part: ref, floor: null };
        o = o.parent as Object3D | null;
      }
    }
    // Walking plane hit.
    const { origin, direction } = raycaster.ray;
    if (direction.y < -0.05) {
      const t = (floorY - origin.y) / direction.y;
      return { part: null, floor: [origin.x + direction.x * t, floorY, origin.z + direction.z * t] };
    }
    return { part: null, floor: null };
  };

  let hovered: PartRef | null = null;
  const controls = new LookController(container, { pos: [0, EYE_HEIGHT, 0], yaw: 0, pitch: 0 }, {
    onTap: (x, y) => {
      const r = pick(x, y);
      events.onTap?.(r.part, r.floor);
    },
    onHover: (x, y) => {
      const r = pick(x, y).part;
      if (r?.objectId !== hovered?.objectId || r?.part !== hovered?.part) {
        hovered = r;
        events.onHover?.(r);
      }
    },
  });

  const highlight = (target: PartRef | null) => {
    const p = target ? parts.get(`${target.objectId}.${target.part}`) : undefined;
    viewer.setHighlightObjects((p?.meshes ?? []).map((m) => ({ object: m as never })));
    viewer.requestRender();
  };

  const tweens = new Set<{ key: string; from: number; to: number; t: number; dur: number; done: () => void }>();
  const applyJoint = (p: PartState) => {
    tmpJ.fromArray(jointMatrix(p.joint, p.t) as unknown as number[]);
    tmpM.multiplyMatrices(tmpJ, p.rest);
    tmpM.decompose(p.node.position, p.node.quaternion, p.node.scale);
    p.node.setMatrixDirty();
  };

  // Render loop: only re-render when something moved.
  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const rot = new Euler(0, 0, 0, 'YXZ');
  const frame = (now: number) => {
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let dirty = controls.update(dt);
    if (figure && figure.root.visible && figure.update(dt)) dirty = true;
    for (const tw of tweens) {
      tw.t = Math.min(1, tw.t + (dt * 1000) / tw.dur);
      const k = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      const p = parts.get(tw.key)!;
      p.t = tw.from + (tw.to - tw.from) * k;
      applyJoint(p);
      if (tw.t >= 1) {
        tweens.delete(tw);
        tw.done();
      }
      dirty = true;
    }
    const { pos, yaw, pitch } = controls.pose;
    camera.position.set(pos[0], pos[1], pos[2]);
    rot.set(pitch, yaw, 0);
    camera.rotation.copy(rot);
    camera.updateMatrixWorld(true);
    if (dirty || forceFrames > 0) {
      viewer.render();
      forceFrames = Math.max(0, forceFrames - 1);
    }
    raf = requestAnimationFrame(frame);
  };
  let forceFrames = 30;
  viewer.requestRenderHandler = () => {
    forceFrames = Math.max(forceFrames, 2);
  };
  raf = requestAnimationFrame(frame);

  const resize = new ResizeObserver(() => {
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
    viewer.resize();
    forceFrames = Math.max(forceFrames, 2);
  });
  resize.observe(container);

  async function loadObject(o: PlacedObject) {
    const buf = await (await fetch(o.glbUrl)).arrayBuffer();
    const res = await GLTFLoader.loadGLTF(buf, { textureLoader: downloadTexture as never });
    const root = new Object3D();
    if (disposed) return root;
    const model = res.scene as unknown as Object3D;
    root.add(model);
    root.position.set(o.position[0], o.position[1], o.position[2]);
    root.rotation.y = o.rotationY;
    root.scale.setScalar(o.scale);
    root.updateMatrixWorld(true);
    scene.add(root);
    objectRoots.set(o.objectId, root);
    for (const joint of o.joints) {
      const node = model.getObjectByName(joint.node) ?? model.getObjectByName(joint.part);
      if (!node) continue;
      const rest = new Matrix4().copy(node.matrix);
      const meshes: Object3D[] = [];
      node.traverse((c: Object3D) => {
        if ((c as unknown as { isMesh?: boolean }).isMesh || (c as unknown as { geometry?: unknown }).geometry) meshes.push(c);
      });
      const ref = { objectId: o.objectId, part: joint.part };
      meshOwner.set(node, ref);
      parts.set(`${o.objectId}.${joint.part}`, { joint, node, rest, t: 0, meshes });
    }
    return root;
  }

  let operator: InstanceType<typeof SplatUtils.SplatOperator> | null = null;
  const cutouts = new Map<string, NonNullable<PlacedObject['cutout']>>();
  function cutOut(splat: Object3D, boxes: NonNullable<PlacedObject['cutout']>[]) {
    operator ??= new SplatUtils.SplatOperator(splat as never, SplatUtils.createSplatData(splat as never));
    const op = operator;
    op.clearState();
    if (boxes.length === 0) return;
    const inv = new Matrix4().getInverse((splat as Object3D).matrixWorld);
    const local = boxes.map((b) => {
      const box = new Box3(
        new Vector3(b.center[0] - b.size[0] / 2, b.center[1] - b.size[1] / 2, b.center[2] - b.size[2] / 2),
        new Vector3(b.center[0] + b.size[0] / 2, b.center[1] + b.size[1] / 2, b.center[2] + b.size[2] / 2),
      );
      return box.applyMatrix4(inv);
    });
    const hidden: number[] = [];
    op.foreachSplatCenter((i, x, y, z) => {
      for (const b of local) {
        if (x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y && z >= b.min.z && z <= b.max.z) {
          hidden.push(i);
          return;
        }
      }
    });
    if (hidden.length) op.setState(hidden, SplatState.Deleted);
  }

  function computeBounds() {
    if (!splatObj) return;
    try {
      operator ??= new SplatUtils.SplatOperator(splatObj as never, SplatUtils.createSplatData(splatObj as never));
      const dense = SplatUtils.computeDenseBox(operator, 0.96);
      const a = new Vector3(...(dense.boxMin as Vec3)).applyMatrix4(splatObj.matrixWorld);
      const b = new Vector3(...(dense.boxMax as Vec3)).applyMatrix4(splatObj.matrixWorld);
      const shrink = 0.35;
      controls.bounds = {
        min: [Math.min(a.x, b.x) + shrink, 0, Math.min(a.z, b.z) + shrink],
        max: [Math.max(a.x, b.x) - shrink, 0, Math.max(a.z, b.z) - shrink],
      };
    } catch {
      controls.bounds = null;
    }
  }

  function refreshObstacles() {
    controls.obstacles = [...objectRoots.values()].map((root) => {
      const box = new Box3().setFromObject(root as never);
      const pad = 0.28;
      return { min: [box.min.x - pad, box.min.y, box.min.z - pad], max: [box.max.x + pad, box.max.y, box.max.z + pad] } as Bounds;
    });
  }

  function applyCutouts() {
    if (splatObj) cutOut(splatObj, [...cutouts.values()]);
    forceFrames = Math.max(forceFrames, 2);
  }

  let field: VoxelCollision | null = null;
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].join();
  const groundAt = (x: number, z: number, fromY = floorY + EYE_HEIGHT): number | null => {
    const hit = field?.queryRay(x, fromY, z, 0, -1, 0, 4) ?? null;
    return hit ? hit.y : null;
  };
  const collide = (p: [number, number, number]): [number, number, number] => {
    let [x, y, z] = p;
    const g = groundAt(x, z, y);
    const floor = g !== null && y - g < EYE_HEIGHT + 0.6 ? g : floorY;
    y = floor + EYE_HEIGHT;
    const r = 0.2;
    const bottom = floor + 0.4;
    const top = y + 0.1;
    const push = { x: 0, y: 0, z: 0 };
    if (field!.queryCapsule(x, (bottom + top) / 2, z, Math.max(0, (top - bottom) / 2 - r), r, push)) {
      x += push.x;
      z += push.z;
    }
    return [x, y, z];
  };

  async function loadSpace(splatSpec: RoomDoc['splat'], spawn: RoomDoc['spawn']) {
    const data = await SplatLoader.parseSplatData(formatOf(splatSpec.format), splatSpec.url, SplatLoader.SplatPackType.Compressed);
    const splat = (await SplatUtils.createSplat(data)) as unknown as Object3D;
    if (disposed) return;
    new Matrix4().fromArray(splatSpec.transform).decompose(splat.position, splat.quaternion, splat.scale);
    splat.updateMatrixWorld(true);
    scene.add(splat);
    splatObj = splat;
    operator = null;
    floorY = spawn.pos[1] - EYE_HEIGHT;
    controls.pose = { pos: [...spawn.pos], yaw: spawn.yaw, pitch: spawn.pitch };
    computeBounds();
    field = null;
    controls.collide = null;
    // Collision voxels are generated in the splat's own frame; use them when that frame is the world frame.
    if (splatSpec.collision && splatSpec.transform.join() === IDENT) {
      field = await loadVoxelCollision(splatSpec.collision.metaUrl, splatSpec.collision.binUrl).catch(() => null);
      if (field) {
        const g = groundAt(spawn.pos[0], spawn.pos[2], spawn.pos[1]);
        if (g !== null) floorY = g;
        controls.collide = collide;
      }
    }
    forceFrames = 10;
  }

  return {
    controls,
    loadSpace,
    async loadRoom(doc) {
      events.onProgress?.(0.02, 'room');
      await loadSpace(doc.splat, doc.spawn);
      events.onProgress?.(0.6, 'furniture');
      let done = 0;
      await Promise.all(
        doc.objects.map(async (o) => {
          await loadObject(o);
          if (o.cutout) cutouts.set(o.objectId, o.cutout);
          events.onProgress?.(0.6 + (0.35 * ++done) / doc.objects.length, 'furniture');
        }),
      );
      applyCutouts();
      refreshObstacles();
      events.onProgress?.(1, 'ready');
      forceFrames = 10;
    },
    setSplatTransform(transform) {
      if (!splatObj) return;
      new Matrix4().fromArray(transform).decompose(splatObj.position, splatObj.quaternion, splatObj.scale);
      splatObj.setMatrixDirty();
      splatObj.updateMatrixWorld(true);
      computeBounds();
      applyCutouts();
    },
    async addObject(o) {
      if (objectRoots.has(o.objectId)) return;
      await loadObject(o);
      if (o.cutout) {
        cutouts.set(o.objectId, o.cutout);
        applyCutouts();
      }
      refreshObstacles();
      forceFrames = Math.max(forceFrames, 4);
    },
    updateObject(objectId, patch) {
      const root = objectRoots.get(objectId);
      if (!root) return;
      if (patch.position) root.position.set(patch.position[0], patch.position[1], patch.position[2]);
      if (patch.rotationY !== undefined) root.rotation.y = patch.rotationY;
      if (patch.scale !== undefined) root.scale.setScalar(patch.scale);
      root.setMatrixDirty();
      root.updateMatrixWorld(true);
      if ('cutout' in patch) {
        if (patch.cutout) cutouts.set(objectId, patch.cutout);
        else cutouts.delete(objectId);
        applyCutouts();
      }
      refreshObstacles();
      forceFrames = Math.max(forceFrames, 2);
    },
    removeObject(objectId) {
      const root = objectRoots.get(objectId);
      if (!root) return;
      scene.remove(root);
      objectRoots.delete(objectId);
      for (const [k, p] of parts) if (k.startsWith(`${objectId}.`)) {
        meshOwner.delete(p.node);
        parts.delete(k);
      }
      if (cutouts.delete(objectId)) applyCutouts();
      refreshObstacles();
      forceFrames = Math.max(forceFrames, 2);
    },
    objectSize(objectId) {
      const root = objectRoots.get(objectId);
      if (!root) return null;
      const box = new Box3().setFromObject(root as never);
      return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
    },
    floorY: () => floorY,
    async character(spec) {
      figureLoad ??= (async () => {
        const c = new Character(animationPlugin);
        await c.load(spec);
        scene.add(c.root);
        figure = c;
        return c;
      })();
      const c = await figureLoad;
      return {
        place: (x, z, yaw) => c.place(x, groundAt(x, z) ?? floorY, z, yaw),
        walkTo: (x, z) => c.walkTo(x, z),
        face: (x, z) => c.face(x, z),
        play: (role) => c.play(role),
        has: (role) => c.has(role),
        position: () => c.position(),
        show: (v) => {
          c.root.visible = v;
          forceFrames = Math.max(forceFrames, 2);
        },
      };
    },
    groundAt: (x, z) => groundAt(x, z) ?? floorY,
    setJoint(objectId, part, t) {
      const p = parts.get(`${objectId}.${part}`);
      if (!p) return;
      p.t = Math.max(0, Math.min(1, t));
      applyJoint(p);
      forceFrames = Math.max(forceFrames, 2);
    },
    getJoint: (objectId, part) => parts.get(`${objectId}.${part}`)?.t ?? 0,
    animateJoint(objectId, part, to, ms = 900) {
      const key = `${objectId}.${part}`;
      const p = parts.get(key);
      if (!p) return Promise.resolve();
      for (const tw of tweens) if (tw.key === key) tweens.delete(tw);
      return new Promise((done) => tweens.add({ key, from: p.t, to: Math.max(0, Math.min(1, to)), t: 0, dur: ms, done }));
    },
    parts: () => [...parts.values()].map((p) => meshOwner.get(p.node)!),
    partPosition(objectId, part) {
      const p = parts.get(`${objectId}.${part}`);
      if (!p) return null;
      const box = new Box3().setFromObject(p.node as never);
      const c = new Vector3();
      box.getCenter(c);
      return [c.x, c.y, c.z];
    },
    highlight,
    project(p) {
      const v = new Vector3(p[0], p[1], p[2]).project(camera);
      if (v.z > 1) return null;
      const r = container.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    pose: () => controls.pose,
    snapshot(type = 'image/jpeg') {
      viewer.render();
      return viewer.readRenderResultDataUrl(type);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      controls.dispose();
      viewer.destroy();
      void splatObj;
    },
  };
}
