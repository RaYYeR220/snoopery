// The landing hero: a filmed room drawn as soft points in the dark. A torch (the cursor, or an automatic tour along
// the solver's way out) restores true colour; the furniture it finds lights up on its joint and opens.
// Plain 2D canvas: one ImageData splat pass per frame, depth-sorted with a counting sort.

export type HeroLook = 'a' | 'b';

export interface TorchOptions {
  look: HeroLook;
  accent: [number, number, number];
  ground: [number, number, number];
  onStep?: (step: number) => void;
  reduceMotion?: boolean;
}

interface Container {
  id: string;
  obj: keyof typeof FURN;
  l1: string;
  l2: string;
  item: string;
  kind: 'prismatic' | 'revolute';
  axis: [number, number, number];
  max: number;
}

interface Furn {
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  h: number;
  y0?: number;
}

interface PartState {
  pivot: number[];
  axis: number[];
  o: Furn;
  box: number[];
  open: number;
  target: number;
  lit: number;
  hold: number;
  dwell: number;
  manual: boolean;
  c: Container;
  M: number[] | null;
  T: number[];
  screen?: { x: number; y: number; r: number };
}

const FLOOR = -0.45;
// Furniture placements in the scanned apartment (world, Y-up metres); yaw turns the object's front (+Z) about Y.
const FURN = {
  nightstand: { x: -5.62, z: 5.35, yaw: Math.PI / 2, w: 0.48, d: 0.42, h: 0.62 } as Furn,
  dresser: { x: 5.75, z: -4.6, yaw: 0, w: 1.1, d: 0.48, h: 0.86 } as Furn,
  wardrobe: { x: -8.62, z: -0.75, yaw: Math.PI / 2, w: 1.0, d: 0.58, h: 2.0 } as Furn,
  jbox: { x: -5.6, z: 5.29, yaw: Math.PI / 2, w: 0.24, d: 0.2, h: 0.1, y0: FLOOR + 0.62 } as Furn,
};

// Containers in the order of the example room's shortest solution.
const C: Container[] = [
  { id: 'nightstand.top_drawer', obj: 'nightstand', l1: 'nightstand · top drawer', l2: 'slide · 0–0.30 m', item: 'folded note', kind: 'prismatic', axis: [0, 0, 1], max: 0.3 },
  { id: 'jewelry_box.lid', obj: 'jbox', l1: 'jewellery box · lid', l2: 'hinge · 0–1.9 rad · code 0412', item: 'brass key', kind: 'revolute', axis: [-1, 0, 0], max: 1.9 },
  { id: 'dresser.drawer_2', obj: 'dresser', l1: 'dresser · drawer 2', l2: 'slide · key lock', item: 'small iron key', kind: 'prismatic', axis: [0, 0, 1], max: 0.34 },
  { id: 'wardrobe.left_door', obj: 'wardrobe', l1: 'wardrobe · left door', l2: 'hinge · key lock', item: 'door key', kind: 'revolute', axis: [0, 1, 0], max: 1.75 },
];

const LV = 44;
const R0 = 0.55;
const RS = 0.2;
interface Kernel {
  R: number;
  n: number;
  dx: Int16Array;
  dy: Int16Array;
  w: Uint8Array;
  lin: Int32Array;
}
const K: Kernel[] = [];
for (let l = 0; l < LV; l++) {
  const r = R0 + l * RS;
  for (let p = 0; p < 4; p++) {
    const ox = 0.25 + 0.5 * (p & 1);
    const oy = 0.25 + 0.5 * (p >> 1);
    const R = Math.ceil(r + 1);
    const dx: number[] = [];
    const dy: number[] = [];
    const w: number[] = [];
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        const c = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - ox, y + 0.5 - oy)));
        if (c > 0.02) {
          dx.push(x);
          dy.push(y);
          w.push(Math.round(c * 255));
        }
      }
    K.push({ R, n: w.length, dx: Int16Array.from(dx), dy: Int16Array.from(dy), w: Uint8Array.from(w), lin: new Int32Array(w.length) });
  }
}

const rnd = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

function toWorld(o: Furn, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  return [o.x + lx * c + lz * s, (o.y0 ?? FLOOR) + ly, o.z - lx * s + lz * c];
}

function rot(axis: number[], th: number) {
  const [ax, ay, az] = axis as [number, number, number];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const t = 1 - c;
  return [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay, t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax, t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export async function loadRoomPoints(url: string): Promise<{ positions: Float32Array; colors: Uint8Array; count: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  const count = view.getUint32(4, true);
  return { count, positions: new Float32Array(buf, 8, count * 3), colors: new Uint8Array(buf, 8 + count * 12, count * 3) };
}

export class TorchScene {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private bs = 1;
  private rs = 1;
  private BW = 0;
  private BH = 0;
  private img!: ImageData;
  private u32!: Uint32Array;
  private bg32!: Uint32Array;
  private mobile = false;
  private fit = { f: 1, cx: 0, cy: 0 };
  private FS = 0;
  private N = 0;
  private PX!: Float32Array;
  private PY!: Float32Array;
  private PZ!: Float32Array;
  private CR!: Uint8Array;
  private CG!: Uint8Array;
  private CB!: Uint8Array;
  private DR!: Uint8Array;
  private DG!: Uint8Array;
  private DB!: Uint8Array;
  private CA!: Uint8Array;
  private PART!: Int8Array;
  private LIT!: Float32Array;
  private SX!: Float32Array;
  private SY!: Float32Array;
  private SD!: Float32Array;
  private OK!: Uint8Array;
  private ORDER!: Uint32Array;
  private BK!: Uint16Array;
  private COUNT = new Uint32Array(1024);
  private parts: PartState[] = [];
  private CAM = { tx: -0.9, ty: 0.2, tz: 0.5, yaw: 0, pitch: 0.7, dist: 15 };
  private P3 = { cy: 1, sy: 0, cp: 1, sp: 0 };
  private torch = { x: 0, y: 0, r: 250, mode: 'auto' as 'auto' | 'cursor', px: 0, py: 0, lastMove: -1e9 };
  private anchors: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  private TOUR = [
    { k: 0, dwell: 1.5, travel: 0.55 },
    { k: 1, dwell: 1.7, travel: 1.45 },
    { w: 'br', travel: 1.35 },
    { k: 2, dwell: 1.7, travel: 1.45 },
    { w: 'tc', travel: 1.45 },
    { k: 3, dwell: 1.7, travel: 1.6 },
  ] as { k?: number; w?: string; dwell?: number; travel: number }[];
  private TOUR_LEN = 0;
  private t0 = performance.now();
  private prevT = 0;
  private running = false;
  private visible = true;
  private avg = 0;
  private frames = 0;
  private pYaw = 0;
  private tYaw = 0;
  private step = 0;
  private tmp = [0, 0, 0];
  private off: (() => void)[] = [];
  private accent: string;
  private accentA: (a: number) => string;

  constructor(
    private readonly stage: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: TorchOptions,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const [r, g, b] = opts.accent;
    this.accent = `rgb(${r},${g},${b})`;
    this.accentA = (a) => `rgba(${r},${g},${b},${a})`;
    this.TOUR_LEN = this.TOUR.reduce((a, s) => a + (s.dwell ?? 0) + s.travel, 0);
    this.resize();
  }

  setRoom(room: { positions: Float32Array; colors: Uint8Array; count: number }) {
    this.buildScene(room);
    this.fitCamera();
    for (let k = 0; k < 4; k++) this.anchors[k] = this.partScreen(k);
    this.torch.x = this.anchors[0]![0]!;
    this.torch.y = this.anchors[0]![1]!;
    this.t0 = performance.now();
    if (this.opts.reduceMotion) {
      this.update(9, 0);
      this.draw();
      this.opts.onStep?.(4);
      return;
    }
    this.start();
  }

  attach(hero: HTMLElement) {
    const on = <T extends Event>(el: EventTarget, type: string, fn: (e: T) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.off.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on<PointerEvent>(hero, 'pointermove', (e) => {
      if (this.opts.reduceMotion || e.pointerType === 'touch') return;
      const r = this.stage.getBoundingClientRect();
      this.torch.px = e.clientX - r.left;
      this.torch.py = e.clientY - r.top;
      this.torch.mode = 'cursor';
      this.torch.lastMove = (performance.now() - this.t0) / 1000;
      this.tYaw = ((e.clientX - r.left) / r.width - 0.5) * 0.06;
    });
    on(hero, 'pointerleave', () => {
      this.torch.lastMove = -1e9;
      this.tYaw = 0;
    });
    on<MouseEvent>(this.canvas, 'click', (e) => {
      if (this.opts.reduceMotion) return;
      const r = this.stage.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const t = (performance.now() - this.t0) / 1000;
      this.parts.forEach((p, k) => {
        if (p.lit > 0.3 && p.screen && Math.hypot(x - p.screen.x, y - p.screen.y) < p.screen.r) {
          p.target = p.target > 0.5 ? 0 : 1;
          p.manual = p.target === 1;
          p.hold = t;
          if (p.target) this.step = Math.max(this.step, k * 2 + 2);
        }
      });
    });
    const io = new IntersectionObserver((es) => {
      this.visible = !!es[0]?.isIntersecting;
      if (this.visible) this.start();
    });
    io.observe(hero);
    this.off.push(() => io.disconnect());
    on(document, 'visibilitychange', () => !document.hidden && this.start());
    let rz: ReturnType<typeof setTimeout>;
    on(window, 'resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        this.resize();
        if (this.N) {
          if (this.opts.reduceMotion) this.update(9, 0);
          this.draw();
        }
      }, 80);
    });
  }

  dispose() {
    this.running = false;
    this.off.forEach((f) => f());
  }

  private start() {
    if (!this.running && this.N && !this.opts.reduceMotion) {
      this.running = true;
      this.prevT = (performance.now() - this.t0) / 1000;
      requestAnimationFrame(this.loop);
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    const t = (now - this.t0) / 1000;
    const dt = Math.min(0.05, t - this.prevT);
    this.prevT = t;
    this.pYaw += (this.tYaw - this.pYaw) * 0.05;
    const s = performance.now();
    this.update(t, dt);
    this.draw();
    this.opts.onStep?.(this.step);
    const ms = performance.now() - s;
    this.avg = this.avg ? this.avg * 0.92 + ms * 0.08 : ms;
    this.frames++;
    if (this.frames > 50 && this.avg > 22 && this.rs > 0.62) {
      this.rs = Math.max(0.6, this.rs * 0.85);
      this.frames = 0;
      this.avg = 0;
      this.resize();
      this.draw();
    }
    if (this.visible && !document.hidden) requestAnimationFrame(this.loop);
    else this.running = false;
  };

  private resize() {
    this.cssW = this.stage.clientWidth;
    this.cssH = this.stage.clientHeight;
    this.mobile = innerWidth <= 640;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.bs = dpr * this.rs;
    this.BW = Math.max(1, Math.round(this.cssW * this.bs));
    this.BH = Math.max(1, Math.round(this.cssH * this.bs));
    this.canvas.width = this.BW;
    this.canvas.height = this.BH;
    this.img = this.ctx.createImageData(this.BW, this.BH);
    this.u32 = new Uint32Array(this.img.data.buffer);
    for (const k of K) for (let i = 0; i < k.n; i++) k.lin[i] = k.dy[i]! * this.BW + k.dx[i]!;
    const oc = document.createElement('canvas');
    oc.width = this.BW;
    oc.height = this.BH;
    const bx = oc.getContext('2d', { willReadFrequently: true })!;
    const [gr, gg, gb] = this.opts.ground;
    bx.fillStyle = `rgb(${gr},${gg},${gb})`;
    bx.fillRect(0, 0, this.BW, this.BH);
    const pool = (x: number, y: number, r: number, c: string) => {
      const g = bx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      bx.fillStyle = g;
      bx.fillRect(0, 0, this.BW, this.BH);
    };
    pool(this.BW * 0.5, this.BH * 0.55, Math.max(this.BW, this.BH) * 0.6, 'rgba(26,26,24,.9)');
    pool(this.BW * 0.88, this.BH * 0.12, Math.max(this.BW, this.BH) * 0.3, this.accentA(0.03));
    this.bg32 = new Uint32Array(bx.getImageData(0, 0, this.BW, this.BH).data.buffer.slice(0));
    this.torch.r = this.mobile ? 105 : Math.min(280, Math.max(220, this.cssW * 0.17));
    if (this.N) this.fitCamera();
  }

  private buildScene(room: { positions: Float32Array; colors: Uint8Array; count: number }) {
    const P = room.positions;
    const Cc = room.colors;
    const rand = rnd(11);
    const pts: number[][] = [];
    const vox = new Map<number, number>();
    const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    const cell = (v: number) => Math.floor(v / 0.25);
    for (let i = 0; i < room.count; i++) {
      const k = key(cell(P[i * 3]!), cell(P[i * 3 + 1]!), cell(P[i * 3 + 2]!));
      vox.set(k, (vox.get(k) ?? 0) + 1);
    }
    const lonely = (x: number, y: number, z: number) => {
      let c = 0;
      const bx = cell(x);
      const by = cell(y);
      const bz = cell(z);
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let d = -1; d <= 1; d++) {
            c += vox.get(key(bx + a, by + b, bz + d)) ?? 0;
            if (c > 2) return false;
          }
      return true;
    };
    const clear = Object.values(FURN).map((o) => ({ o, hx: o.w / 2 + 0.06, hz: o.d / 2 + 0.06 }));
    const inFoot = (x: number, y: number, z: number) =>
      clear.some(({ o, hx, hz }) => {
        const c = Math.cos(o.yaw);
        const s = Math.sin(o.yaw);
        const dx = x - o.x;
        const dz = z - o.z;
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        return Math.abs(lx) < hx && Math.abs(lz) < hz && y > FLOOR + 0.05 && y < (o.y0 ?? FLOOR) + o.h + 0.25;
      });
    for (let i = 0; i < room.count; i++) {
      const x = P[i * 3]!;
      const y = P[i * 3 + 1]!;
      const z = P[i * 3 + 2]!;
      if (y > 1.85 || y < -0.7 || x < -10.3 || x > 8.5 || z < -8 || z > 8.4) continue;
      if (lonely(x, y, z) || inFoot(x, y, z)) continue;
      let r = Cc[i * 3]!;
      let g = Cc[i * 3 + 1]!;
      let b = Cc[i * 3 + 2]!;
      let a = 235;
      if (r + g + b < 24) {
        r = 54;
        g = 54;
        b = 52;
        a = 150;
      }
      pts.push([x, y, z, -1, r, g, b, a]);
    }
    this.FS = pts.length;
    const dens = 380;
    const surf = (o: Furn, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number, col: number[], a: number, faces = 'fblrtb', k = 1) => {
      const add = (n: number, f: (u: number, v: number) => number[]) => {
        for (let q = 0; q < n * k; q++) {
          const L = f(rand(), rand());
          const w = toWorld(o, L[0]!, L[1]!, L[2]!);
          const j = rand() * 14 - 7;
          pts.push([w[0], w[1], w[2], part, col[0]! + j, col[1]! + j, col[2]! + j, a]);
        }
      };
      const W = x1 - x0;
      const H = y1 - y0;
      const D = z1 - z0;
      const edge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        const n = Math.max(2, (Math.hypot(bx - ax, by - ay, bz - az) / 0.014) * Math.min(1.6, k));
        for (let q = 0; q <= n; q++) {
          const u = q / n;
          const w = toWorld(o, ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u);
          pts.push([w[0], w[1], w[2], part, col[0]! * 0.78, col[1]! * 0.78, col[2]! * 0.78, Math.min(255, a + 15)]);
        }
      };
      if (faces.includes('f')) {
        edge(x0, y0, z1, x1, y0, z1);
        edge(x0, y1, z1, x1, y1, z1);
        edge(x0, y0, z1, x0, y1, z1);
        edge(x1, y0, z1, x1, y1, z1);
      }
      if (faces.includes('t')) {
        edge(x0, y1, z0, x1, y1, z0);
        edge(x0, y1, z0, x0, y1, z1);
        edge(x1, y1, z0, x1, y1, z1);
      }
      if (faces.includes('l') && !faces.includes('t')) edge(x0, y0, z0, x0, y1, z0);
      if (faces.includes('f')) add(W * H * dens, (u, v) => [x0 + u * W, y0 + v * H, z1]);
      if (faces.includes('k')) add(W * H * dens * 0.6, (u, v) => [x0 + u * W, y0 + v * H, z0]);
      if (faces.includes('l')) add(D * H * dens, (u, v) => [x0, y0 + v * H, z0 + u * D]);
      if (faces.includes('r')) add(D * H * dens, (u, v) => [x1, y0 + v * H, z0 + u * D]);
      if (faces.includes('t')) add(W * D * dens, (u, v) => [x0 + u * W, y1, z0 + v * D]);
      if (faces.includes('b')) add(W * D * dens * 0.7, (u, v) => [x0 + u * W, y0, z0 + v * D]);
    };
    const oak = [148, 112, 78];
    const walnut = [104, 74, 52];
    const paint = [150, 142, 130];
    {
      const o = FURN.nightstand;
      const hw = o.w / 2;
      const hd = o.d / 2;
      surf(o, -hw, hw, 0, 0.43, -hd, hd, -1, oak, 235, 'fklrt');
      surf(o, -hw, hw, 0.58, 0.62, -hd, hd, -1, oak, 235, 'ftlr');
      surf(o, -hw, -hw + 0.02, 0.43, 0.58, -hd, hd, -1, oak, 235, 'l');
      surf(o, hw - 0.02, hw, 0.43, 0.58, -hd, hd, -1, oak, 235, 'r');
      surf(o, -hw + 0.025, hw - 0.025, 0.445, 0.58, -hd + 0.02, hd, 0, [170, 132, 94], 245, 'flrb');
      surf(o, -0.08, 0.06, 0.47, 0.471, -0.02, 0.1, 0, [236, 230, 214], 250, 't', 3);
    }
    {
      const o = FURN.dresser;
      const hw = o.w / 2;
      const hd = o.d / 2;
      surf(o, -hw, hw, 0, o.h, -hd, hd, -1, walnut, 235, 'klrt');
      [
        [0.06, 0.3],
        [0.31, 0.55],
        [0.56, 0.82],
      ].forEach(([a, b], k) => {
        const part = k === 1 ? 2 : -1;
        surf(o, -hw + 0.02, hw - 0.02, a!, b!, -hd + 0.02, hd, part, k === 1 ? [126, 92, 66] : walnut, 240, part === -1 ? 'f' : 'flrb');
      });
      surf(o, -0.1, 0.02, 0.36, 0.365, -0.05, 0.06, 2, [196, 178, 120], 250, 't', 4);
    }
    {
      const o = FURN.jbox;
      surf(o, -0.12, 0.12, 0, 0.1, -0.1, 0.1, -1, [58, 40, 44], 245, 'fklr', 3);
      surf(o, -0.11, 0.11, 0.015, 0.016, -0.09, 0.09, -1, [150, 40, 52], 245, 't', 3);
      surf(o, -0.125, 0.125, 0.1, 0.135, -0.105, 0.105, 1, [74, 52, 56], 250, 'tf', 3);
      surf(o, -0.04, 0.04, 0.03, 0.031, -0.03, 0.04, -1, [226, 182, 92], 255, 't', 6);
    }
    {
      const o = FURN.wardrobe;
      const hw = o.w / 2;
      const hd = o.d / 2;
      surf(o, -hw, hw, 0, o.h, -hd, hd - 0.02, -1, paint, 225, 'klrt');
      surf(o, -hw + 0.02, hw - 0.02, 0.02, o.h - 0.02, -hd + 0.02, -hd + 0.021, -1, [120, 116, 108], 200, 'f', 0.8);
      surf(o, -hw + 0.02, hw - 0.02, 1.4, 1.42, -hd, hd - 0.03, -1, [140, 136, 128], 200, 't', 1.4);
      surf(o, -hw, 0, 0, o.h, hd - 0.02, hd, 3, [166, 158, 146], 235, 'f');
      surf(o, 0, hw, 0, o.h, hd - 0.02, hd, -1, [166, 158, 146], 235, 'f');
      surf(o, -0.32, -0.18, 0.9, 1.05, -0.1, 0.12, -1, [210, 170, 90], 250, 'tf', 2.5);
    }
    const N = (this.N = pts.length);
    this.PX = new Float32Array(N);
    this.PY = new Float32Array(N);
    this.PZ = new Float32Array(N);
    this.CR = new Uint8Array(N);
    this.CG = new Uint8Array(N);
    this.CB = new Uint8Array(N);
    this.DR = new Uint8Array(N);
    this.DG = new Uint8Array(N);
    this.DB = new Uint8Array(N);
    this.CA = new Uint8Array(N);
    this.PART = new Int8Array(N);
    this.LIT = new Float32Array(N);
    this.SX = new Float32Array(N);
    this.SY = new Float32Array(N);
    this.SD = new Float32Array(N);
    this.OK = new Uint8Array(N);
    this.ORDER = new Uint32Array(N);
    this.BK = new Uint16Array(N);
    const look = this.opts.look;
    for (let i = 0; i < N; i++) {
      const q = pts[i]!;
      this.PX[i] = q[0]!;
      this.PY[i] = q[1]!;
      this.PZ[i] = q[2]!;
      this.PART[i] = q[3]!;
      const r = Math.max(0, Math.min(255, q[4]!));
      const g = Math.max(0, Math.min(255, q[5]!));
      const b = Math.max(0, Math.min(255, q[6]!));
      this.CR[i] = Math.min(255, r * 1.08);
      this.CG[i] = Math.min(255, g * 1.08);
      this.CB[i] = Math.min(255, b * 1.08);
      this.CA[i] = q[7]!;
      if (look === 'a') {
        // Look A: the dark room is a warm neutral grey; only the torch brings colour back.
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        this.DR[i] = 20 + l * 40;
        this.DG[i] = 20 + l * 39;
        this.DB[i] = 19 + l * 36;
      } else {
        // Look B: the room keeps a dim version of its own colour.
        this.DR[i] = r * 0.3 + 8;
        this.DG[i] = g * 0.3 + 8;
        this.DB[i] = b * 0.3 + 8;
      }
    }
    const nsO = FURN.nightstand;
    const jbO = FURN.jbox;
    const drO = FURN.dresser;
    const wdO = FURN.wardrobe;
    const ax = (o: Furn, a: number[]) => {
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      return [a[0]! * c + a[2]! * s, a[1]!, -a[0]! * s + a[2]! * c];
    };
    const mk = (k: number, pivot: number[], axis: number[], o: Furn, box: number[]): PartState => ({ pivot, axis, o, box, open: 0, target: 0, lit: 0, hold: 0, dwell: 0, manual: false, c: C[k]!, M: null, T: [0, 0, 0] });
    this.parts = [
      mk(0, toWorld(nsO, 0, 0.5125, 0.035), ax(nsO, [0, 0, 1]), nsO, [-0.215, 0.215, 0.445, 0.58, nsO.d / 2]),
      mk(1, toWorld(jbO, 0, 0.1, -0.1), ax(jbO, [-1, 0, 0]), jbO, [-0.125, 0.125, 0.1, 0.135, 0.105]),
      mk(2, toWorld(drO, 0, 0.43, drO.d / 2), ax(drO, [0, 0, 1]), drO, [-drO.w / 2 + 0.02, drO.w / 2 - 0.02, 0.31, 0.55, drO.d / 2]),
      mk(3, toWorld(wdO, -wdO.w / 2, 0, wdO.d / 2 - 0.01), ax(wdO, [0, 1, 0]), wdO, [-wdO.w / 2, 0, 0, wdO.h, wdO.d / 2]),
    ];
  }

  private fitCamera() {
    this.setCam(this.CAM.yaw, this.CAM.pitch);
    const corners = [
      [-9.2, -0.45, -7.0],
      [7.4, -0.45, -7.0],
      [-9.2, -0.45, 7.6],
      [7.4, -0.45, 7.6],
      [-9.2, 1.6, -7.0],
      [7.4, 1.6, -7.0],
    ];
    let u0 = 1e9;
    let u1 = -1e9;
    let v0 = 1e9;
    let v1 = -1e9;
    for (const c of corners) {
      const q = this.projN(c[0]!, c[1]!, c[2]!);
      u0 = Math.min(u0, q[0]);
      u1 = Math.max(u1, q[0]);
      v0 = Math.min(v0, q[1]);
      v1 = Math.max(v1, q[1]);
    }
    const cover = this.mobile ? 1.05 : 1.08;
    this.fit.f = Math.max(this.cssW / (u1 - u0), this.cssH / (v1 - v0)) * cover;
    if (this.mobile) this.fit.f = Math.min((this.cssW + 40) / (u1 - u0), (this.cssH - 70) / (v1 - v0));
    this.fit.cx = this.cssW / 2 - (this.fit.f * (u0 + u1)) / 2;
    this.fit.cy = (this.mobile ? this.cssH / 2 + 22 : this.cssH / 2 + 10) - (this.fit.f * (v0 + v1)) / 2;
  }

  private setCam(yaw: number, pitch: number) {
    this.P3.cy = Math.cos(yaw);
    this.P3.sy = Math.sin(yaw);
    this.P3.cp = Math.cos(pitch);
    this.P3.sp = Math.sin(pitch);
  }

  private projN(x: number, y: number, z: number): [number, number, number] {
    const { CAM, P3 } = this;
    x -= CAM.tx;
    y -= CAM.ty;
    z -= CAM.tz;
    const x1 = x * P3.cy - z * P3.sy;
    const z1 = x * P3.sy + z * P3.cy;
    const y2 = y * P3.cp - z1 * P3.sp;
    const z2 = y * P3.sp + z1 * P3.cp;
    const d = CAM.dist - z2;
    return [x1 / d, -y2 / d, d];
  }

  private proj(x: number, y: number, z: number): [number, number, number] {
    const q = this.projN(x, y, z);
    return [this.fit.cx + this.fit.f * q[0], this.fit.cy + this.fit.f * q[1], q[2]];
  }

  private applyPart(k: number, x: number, y: number, z: number, out: number[]) {
    const p = this.parts[k]!;
    if (p.c.kind === 'prismatic') {
      out[0] = x + p.T[0]!;
      out[1] = y + p.T[1]!;
      out[2] = z + p.T[2]!;
      return;
    }
    const M = p.M!;
    const px = p.pivot[0]!;
    const py = p.pivot[1]!;
    const pz = p.pivot[2]!;
    const lx = x - px;
    const ly = y - py;
    const lz = z - pz;
    out[0] = px + M[0]! * lx + M[1]! * ly + M[2]! * lz;
    out[1] = py + M[3]! * lx + M[4]! * ly + M[5]! * lz;
    out[2] = pz + M[6]! * lx + M[7]! * ly + M[8]! * lz;
  }

  private tourPoint(s: { k?: number; w?: string }): number[] {
    if (s.k !== undefined) return this.anchors[s.k]!;
    if (s.w === 'br') return this.mobile ? [this.cssW * 0.82, this.cssH * 0.52] : [this.cssW * 0.84, this.cssH * 0.74];
    return this.mobile ? [this.cssW * 0.5, this.cssH * 0.12] : [this.cssW * 0.52, this.cssH * 0.15];
  }

  private partScreen(k: number) {
    const p = this.parts[k]!;
    const b = p.box;
    const w = toWorld(p.o, (b[0]! + b[1]!) / 2, (b[2]! + b[3]!) / 2, b[4]!);
    return this.proj(w[0], w[1], w[2]);
  }

  private autoTorch(t: number): [number, number, number, number] {
    const { TOUR, TOUR_LEN } = this;
    let s = (((t - 0.9) % TOUR_LEN) + TOUR_LEN) % TOUR_LEN;
    let i = 0;
    for (; i < TOUR.length; i++) {
      const L = (TOUR[i]!.dwell ?? 0) + TOUR[i]!.travel;
      if (s < L) break;
      s -= L;
    }
    const n = TOUR.length;
    const cur = TOUR[i]!;
    const p0 = this.tourPoint(TOUR[(i - 1 + n) % n]!);
    const p1 = this.tourPoint(cur);
    const p2 = this.tourPoint(TOUR[(i + 1) % n]!);
    const p3 = this.tourPoint(TOUR[(i + 2) % n]!);
    const dw = cur.dwell ?? 0;
    if (s < dw) return [p1[0]! + Math.sin(t * 2.1) * 5, p1[1]! + Math.cos(t * 1.7) * 4, cur.k ?? -1, s];
    const u = smooth((s - dw) / cur.travel);
    const u2 = u * u;
    const u3 = u2 * u;
    const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return [cr(p0[0]!, p1[0]!, p2[0]!, p3[0]!) + Math.sin(t * 3.3) * 3, cr(p0[1]!, p1[1]!, p2[1]!, p3[1]!) + Math.cos(t * 2.9) * 3, -1, 0];
  }

  private update(t: number, dt: number) {
    for (let k = 0; k < 4; k++) this.anchors[k] = this.partScreen(k);
    const { torch, parts } = this;
    if (this.opts.reduceMotion) {
      torch.x = this.anchors[1]![0]!;
      torch.y = this.anchors[1]![1]!;
      parts.forEach((p, k) => {
        p.open = k <= 1 ? 1 : 0;
        p.lit = k === 1 ? 1 : 0;
      });
      this.step = 4;
      return;
    }
    let rest = -1;
    let restT = 0;
    if (torch.mode === 'auto' || t - torch.lastMove > 4.5) {
      torch.mode = 'auto';
      const a = this.autoTorch(t);
      torch.x += (a[0] - torch.x) * 0.16;
      torch.y += (a[1] - torch.y) * 0.16;
      rest = a[2];
      restT = a[3];
    } else {
      torch.x += (torch.px - torch.x) * 0.2;
      torch.y += (torch.py - torch.y) * 0.2;
    }
    const R = torch.r;
    parts.forEach((p, k) => {
      const s = this.anchors[k]!;
      const d = Math.hypot(s[0]! - torch.x, s[1]! - torch.y);
      const lit = Math.max(0, Math.min(1, (R * 0.95 - d) / (R * 0.5)));
      p.lit += (lit - p.lit) * 0.2;
      if (torch.mode === 'auto') {
        if (k === rest && restT > 0.6) {
          p.target = 1;
          p.hold = t;
          if (k * 2 + 2 > this.step || (k === 0 && this.step >= 8)) this.step = k * 2 + 2;
        } else if (t - p.hold > 2.6) p.target = 0;
      } else {
        if (d < 80) {
          p.dwell += dt;
          if (p.dwell > 0.6 && !p.manual) {
            p.target = 1;
            p.hold = t;
            this.step = Math.max(this.step, k * 2 + 2);
          }
        } else p.dwell = 0;
        if (!p.manual && d > R && t - p.hold > 2.6) p.target = 0;
      }
      const sp = p.target > p.open ? 1.05 : 1.3;
      p.open += Math.sign(p.target - p.open) * Math.min(Math.abs(p.target - p.open), dt / sp);
    });
    if (torch.mode === 'auto' && rest === 0 && restT < 0.2 && this.step >= 8) this.step = 0;
    if (rest === 3 && restT > 1.45) this.step = 9;
  }

  private draw() {
    const yaw = this.CAM.yaw + this.pYaw;
    this.setCam(yaw, this.CAM.pitch);
    for (const p of this.parts) {
      const e = p.open < 0.5 ? 4 * p.open ** 3 : 1 - Math.pow(-2 * p.open + 2, 3) / 2;
      const q = p.c.max * e;
      if (p.c.kind === 'prismatic') p.T = [p.axis[0]! * q, p.axis[1]! * q, p.axis[2]! * q];
      else p.M = rot(p.axis, q);
    }
    const { f, cx, cy } = this.fit;
    const { cy: ccy, sy, cp, sp } = this.P3;
    const { dist, tx, ty, tz } = this.CAM;
    const { PX, PY, PZ, PART, OK, SX, SY, SD, LIT, BK, ORDER, COUNT, bs, N, tmp } = this;
    let dmin = 1e9;
    let dmax = -1e9;
    const TX = this.torch.x;
    const TY = this.torch.y;
    const R = this.torch.r;
    const R2 = R * R;
    for (let i = 0; i < N; i++) {
      let x = PX[i]!;
      let y = PY[i]!;
      let z = PZ[i]!;
      const pt = PART[i]!;
      if (pt >= 0) {
        this.applyPart(pt, x, y, z, tmp);
        x = tmp[0]!;
        y = tmp[1]!;
        z = tmp[2]!;
      }
      x -= tx;
      y -= ty;
      z -= tz;
      const x1 = x * ccy - z * sy;
      const z1 = x * sy + z * ccy;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const d = dist - z2;
      if (d < 0.6) {
        OK[i] = 0;
        continue;
      }
      OK[i] = 1;
      const sx = cx + (f * x1) / d;
      const syy = cy - (f * y2) / d;
      SX[i] = sx * bs;
      SY[i] = syy * bs;
      SD[i] = d;
      const ddx = sx - TX;
      const ddy = syy - TY;
      const dd = ddx * ddx + ddy * ddy;
      if (dd < R2) {
        const u = 1 - Math.sqrt(dd) / R;
        LIT[i] = u * u * (3 - 2 * u);
      } else LIT[i] = 0;
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
    }
    COUNT.fill(0);
    const NB = COUNT.length;
    const sc = (NB - 1) / Math.max(1e-3, dmax - dmin);
    for (let i = 0; i < N; i++) {
      if (!OK[i]) continue;
      const b = ((dmax - SD[i]!) * sc) | 0;
      BK[i] = b;
      COUNT[b]!++;
    }
    let acc = 0;
    for (let b = 0; b < NB; b++) {
      const c = COUNT[b]!;
      COUNT[b] = acc;
      acc += c;
    }
    for (let i = 0; i < N; i++) if (OK[i]) ORDER[COUNT[BK[i]!]!++] = i;
    const { u32, BW, BH, CR, CG, CB, DR, DG, DB, CA, FS } = this;
    u32.set(this.bg32);
    const sizeK = 0.024 * f * bs;
    const rmin = 0.6 * bs;
    const rmax = 3.0 * bs;
    for (let k = 0; k < acc; k++) {
      const i = ORDER[k]!;
      const L = LIT[i]!;
      const d = SD[i]!;
      let r = sizeK / d;
      if (r < rmin) r = rmin;
      else if (r > rmax) r = rmax;
      r *= 1 + 0.22 * L;
      let lvl = ((r - R0) / RS + 0.5) | 0;
      if (lvl >= LV) lvl = LV - 1;
      const sxp = SX[i]!;
      const syp = SY[i]!;
      const xi = sxp | 0;
      const yi = syp | 0;
      const kk = K[lvl * 4 + (sxp - xi >= 0.5 ? 1 : 0) + (syp - yi >= 0.5 ? 2 : 0)]!;
      if (xi - kk.R < 0 || yi - kk.R < 0 || xi + kk.R >= BW || yi + kk.R >= BH) continue;
      const cr = DR[i]! + (CR[i]! - DR[i]!) * L;
      const cg = DG[i]! + (CG[i]! - DG[i]!) * L;
      const cb = DB[i]! + (CB[i]! - DB[i]!) * L;
      const A = (CA[i]! * (i < FS ? 0.62 + 0.38 * L : 0.2 + 0.8 * L)) | 0;
      const base = yi * BW + xi;
      const { lin, w, n } = kk;
      for (let j = 0; j < n; j++) {
        const al = (w[j]! * A) >> 8;
        if (!al) continue;
        const o = base + lin[j]!;
        const q = u32[o]!;
        const qr = q & 255;
        const qg = (q >> 8) & 255;
        const qb = (q >> 16) & 255;
        u32[o] = 0xff000000 | ((qb + (((cb - qb) * al) >> 8)) << 16) | ((qg + (((cg - qg) * al) >> 8)) << 8) | (qr + (((cr - qr) * al) >> 8));
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    this.overlay();
  }

  private overlay() {
    const { ctx, torch, mobile, cssW, cssH, tmp } = this;
    ctx.setTransform(this.bs, 0, 0, this.bs, 0, 0);
    const g = ctx.createRadialGradient(torch.x, torch.y, 0, torch.x, torch.y, torch.r * 1.05);
    g.addColorStop(0, 'rgba(255,248,232,.075)');
    g.addColorStop(0.6, 'rgba(255,248,232,.03)');
    g.addColorStop(1, 'rgba(255,248,232,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = g;
    ctx.fillRect(torch.x - torch.r * 1.1, torch.y - torch.r * 1.1, torch.r * 2.2, torch.r * 2.2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = this.opts.look === 'a' ? this.accentA(0.16) : 'rgba(242,241,238,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(torch.x, torch.y, torch.r * 0.96, 0, 7);
    ctx.stroke();
    const fs = mobile ? 10 : 11;
    ctx.font = `500 ${fs}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    const placed: number[][] = [];
    this.parts.forEach((p, k) => {
      const a = Math.min(1, p.lit * 1.25);
      if (a < 0.03) return;
      const b = p.box;
      const c = p.c;
      const face = [
        [b[0]!, b[2]!],
        [b[1]!, b[2]!],
        [b[1]!, b[3]!],
        [b[0]!, b[3]!],
      ].map(([lx, ly]) => {
        const w = toWorld(p.o, lx!, ly!, b[4]! + 0.004);
        this.applyPart(k, w[0], w[1], w[2], tmp);
        return this.proj(tmp[0]!, tmp[1]!, tmp[2]!);
      });
      ctx.globalAlpha = a;
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      face.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = this.accent;
      for (const q of face) {
        ctx.beginPath();
        ctx.arc(q[0], q[1], 1.6, 0, 7);
        ctx.fill();
      }
      const pv = p.pivot;
      const ax = p.axis;
      const Lx = c.kind === 'prismatic' ? c.max + 0.12 : k === 3 ? 2.1 : 0.3;
      const A0 =
        c.kind === 'prismatic'
          ? this.proj(pv[0]! - ax[0]! * 0.06, pv[1]! - ax[1]! * 0.06, pv[2]! - ax[2]! * 0.06)
          : this.proj(pv[0]! - ax[0]! * (k === 3 ? 0.05 : 0.18), pv[1]! - ax[1]! * 0.05, pv[2]! - ax[2]! * (k === 3 ? 0.05 : 0.18));
      const A1 =
        c.kind === 'prismatic'
          ? this.proj(pv[0]! + ax[0]! * Lx, pv[1]! + ax[1]! * Lx, pv[2]! + ax[2]! * Lx)
          : this.proj(pv[0]! + ax[0]! * (k === 3 ? Lx : 0.18), pv[1]! + ax[1]! * (k === 3 ? Lx : 0.05), pv[2]! + ax[2]! * (k === 3 ? Lx : 0.18));
      ctx.globalAlpha = a * 0.75;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(A0[0], A0[1]);
      ctx.lineTo(A1[0], A1[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      const top = face.reduce((m, q) => (q[1] < m[1] ? q : m), face[0]!);
      const right = Math.max(...face.map((q) => q[0]));
      const left = Math.min(...face.map((q) => q[0]));
      const l3 = p.open > 0.55 ? `found · ${c.item}` : '';
      const wB = Math.max(ctx.measureText(c.l1).width, ctx.measureText(c.l2).width, l3 ? ctx.measureText(l3).width : 0) + 18;
      const hB = (l3 ? 3 : 2) * (fs + 5) + 11;
      let bx = right + 26;
      let by = top[1] - hB - 10;
      if (bx + wB > cssW - 14) bx = left - 26 - wB;
      bx = Math.max(10, Math.min(cssW - wB - 10, bx));
      by = Math.max(mobile ? 64 : 80, Math.min(cssH - hB - (mobile ? 40 : 60), by));
      for (let gi = 0; gi < 4; gi++) {
        const hit = placed.find((r) => bx < r[0]! + r[2]! && bx + wB > r[0]! && by < r[1]! + r[3]! + 6 && by + hB + 6 > r[1]!);
        if (!hit) break;
        by = hit[1]! - hB - 8;
      }
      placed.push([bx, by, wB, hB]);
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = this.accentA(0.55);
      const lxp = bx > right ? bx : bx + wB;
      const anchorX = bx > right ? right : left;
      ctx.beginPath();
      ctx.moveTo(anchorX + (bx > right ? 3 : -3), top[1]);
      ctx.lineTo(lxp, by + hB - 6);
      ctx.stroke();
      ctx.globalAlpha = a;
      const [gr, gg, gb] = this.opts.ground;
      ctx.fillStyle = `rgba(${gr},${gg},${gb},.84)`;
      ctx.strokeStyle = this.accentA(0.35);
      ctx.beginPath();
      ctx.roundRect(bx, by, wB, hB, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f2f1ee';
      ctx.fillText(c.l1, bx + 9, by + 7);
      ctx.fillStyle = '#a4a39f';
      ctx.fillText(c.l2, bx + 9, by + 7 + fs + 5);
      if (l3) {
        ctx.globalAlpha = a * Math.min(1, (p.open - 0.55) / 0.3);
        ctx.fillStyle = this.accent;
        ctx.fillText(l3, bx + 9, by + 7 + 2 * (fs + 5));
      }
      p.screen = { x: (left + right) / 2, y: (face[0]![1] + face[2]![1]) / 2, r: Math.max(40, (right - left) * 0.7) };
    });
    ctx.globalAlpha = 1;
  }
}
