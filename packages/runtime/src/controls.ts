export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface Pose {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

export interface LookControllerOptions {
  /** Called on a click/tap that did not turn into a drag. */
  onTap?: (x: number, y: number) => void;
  onHover?: (x: number, y: number) => void;
  speed?: number;
}

const PITCH_LIMIT = 1.35;

/**
 * First-person look + walk for a room: drag to look, WASD/arrows to walk, wheel to step, tap to interact,
 * `glideTo` for click-to-move. Movement stays on the eye-height plane, inside room bounds and outside furniture.
 */
export class LookController {
  pose: Pose;
  bounds: Bounds | null = null;
  obstacles: Bounds[] = [];
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; moved: boolean }>();
  private glide: { from: [number, number, number]; to: [number, number, number]; t: number; dur: number } | null = null;
  private turn: { from: number; to: number; pfrom: number; pto: number; t: number; dur: number } | null = null;
  private readonly el: HTMLElement;
  private readonly opts: LookControllerOptions;
  private readonly off: (() => void)[] = [];
  enabled = true;

  constructor(el: HTMLElement, pose: Pose, opts: LookControllerOptions = {}) {
    this.el = el;
    this.pose = { pos: [...pose.pos], yaw: pose.yaw, pitch: pose.pitch };
    this.opts = opts;
    el.style.touchAction = 'none';
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, target: HTMLElement | Window = el) => {
      target.addEventListener(t, f as EventListener, { passive: false });
      this.off.push(() => target.removeEventListener(t, f as EventListener));
    };
    on('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false });
    });
    on('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.opts.onHover?.(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) p.moved = true;
      if (!this.enabled || !p.moved) return;
      if (this.pointers.size >= 2) {
        // Two-finger drag walks.
        this.move(-dy * 0.004, dx * 0.004);
        return;
      }
      this.turn = null;
      const k = e.pointerType === 'touch' ? 0.006 : 0.0035;
      this.pose.yaw += dx * k;
      this.pose.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pose.pitch + dy * k));
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p && !p.moved && this.pointers.size === 0) this.opts.onTap?.(e.clientX, e.clientY);
    };
    on('pointerup', end);
    on('pointercancel', (e) => this.pointers.delete(e.pointerId));
    on('wheel', (e) => {
      e.preventDefault();
      if (this.enabled) this.move(-Math.sign(e.deltaY) * 0.35, 0);
    });
    on('keydown', (e) => this.keys.add(e.key.toLowerCase()), window as unknown as HTMLElement);
    on('keyup', (e) => this.keys.delete(e.key.toLowerCase()), window as unknown as HTMLElement);
    on('blur', () => this.keys.clear(), window as unknown as HTMLElement);
  }

  dispose() {
    this.off.forEach((f) => f());
  }

  /** Smoothly move to a point on the walking plane (keeps eye height). */
  glideTo(x: number, z: number, ms = 700) {
    const to = this.clamp([x, this.pose.pos[1], z]);
    this.glide = { from: [...this.pose.pos], to, t: 0, dur: ms };
  }

  /** Smoothly turn to face a world point. */
  lookAt(x: number, y: number, z: number, ms = 600) {
    const [px, py, pz] = this.pose.pos;
    const yaw = Math.atan2(-(x - px), -(z - pz));
    const pitch = Math.atan2(y - py, Math.hypot(x - px, z - pz));
    let to = yaw;
    while (to - this.pose.yaw > Math.PI) to -= 2 * Math.PI;
    while (to - this.pose.yaw < -Math.PI) to += 2 * Math.PI;
    this.turn = { from: this.pose.yaw, to, pfrom: this.pose.pitch, pto: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch)), t: 0, dur: ms };
  }

  update(dt: number): boolean {
    let changed = false;
    if (this.enabled) {
      const f = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
      const r = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      if (f || r) {
        const speed = (this.opts.speed ?? 1.4) * dt * (this.keys.has('shift') ? 2 : 1);
        this.move(f * speed, r * speed);
        this.glide = null;
        changed = true;
      }
    }
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    if (this.glide) {
      this.glide.t = Math.min(1, this.glide.t + (dt * 1000) / this.glide.dur);
      const k = ease(this.glide.t);
      this.pose.pos = this.glide.from.map((v, i) => v + (this.glide!.to[i]! - v) * k) as [number, number, number];
      if (this.glide.t >= 1) this.glide = null;
      changed = true;
    }
    if (this.turn) {
      this.turn.t = Math.min(1, this.turn.t + (dt * 1000) / this.turn.dur);
      const k = ease(this.turn.t);
      this.pose.yaw = this.turn.from + (this.turn.to - this.turn.from) * k;
      this.pose.pitch = this.turn.pfrom + (this.turn.pto - this.turn.pfrom) * k;
      if (this.turn.t >= 1) this.turn = null;
      changed = true;
    }
    return changed || this.pointers.size > 0;
  }

  private move(forward: number, right: number) {
    const { yaw } = this.pose;
    const dx = -Math.sin(yaw) * forward + Math.cos(yaw) * right;
    const dz = -Math.cos(yaw) * forward - Math.sin(yaw) * right;
    const [x, y, z] = this.pose.pos;
    this.pose.pos = this.clamp([x + dx, y, z + dz]);
  }

  private clamp(p: [number, number, number]): [number, number, number] {
    let [x, y, z] = p;
    if (this.bounds) {
      x = Math.max(this.bounds.min[0], Math.min(this.bounds.max[0], x));
      z = Math.max(this.bounds.min[2], Math.min(this.bounds.max[2], z));
    }
    for (const o of this.obstacles) {
      if (x > o.min[0] && x < o.max[0] && z > o.min[2] && z < o.max[2]) {
        // Push out along the shallowest axis.
        const push = [
          [o.min[0] - x, 0],
          [o.max[0] - x, 0],
          [0, o.min[2] - z],
          [0, o.max[2] - z],
        ].sort((a, b) => Math.hypot(a[0]!, a[1]!) - Math.hypot(b[0]!, b[1]!))[0]!;
        x += push[0]!;
        z += push[1]!;
      }
    }
    return [x, y, z];
  }
}
