/** Small synthesized foley for the room: no audio files, nothing to load. */
let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export const setMuted = (m: boolean) => {
  muted = m;
};
export const isMuted = () => muted;

function noise(c: AudioContext, seconds: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

function env(c: AudioContext, g: GainNode, at: number, attack: number, hold: number, release: number, peak: number) {
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.setValueAtTime(peak, at + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
}

/** Wood on wood: band-passed noise sweeping down as a drawer runs out. */
export function slide(duration = 0.8) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const src = noise(c, duration + 0.2);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.exponentialRampToValueAtTime(320, t + duration);
  const g = c.createGain();
  env(c, g, t, 0.04, duration * 0.7, 0.25, 0.22);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + duration + 0.2);
  knock(t + duration * 0.95, 0.12);
}

/** A hinge: a slow, slightly detuned creak. */
export function creak(duration = 0.9) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(140, t);
  o.frequency.linearRampToValueAtTime(95, t + duration);
  const lfo = c.createOscillator();
  lfo.frequency.value = 23;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 18;
  lfo.connect(lfoGain).connect(o.frequency);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1100;
  bp.Q.value = 6;
  const g = c.createGain();
  env(c, g, t, 0.08, duration * 0.6, 0.3, 0.06);
  o.connect(bp).connect(g).connect(c.destination);
  o.start(t);
  lfo.start(t);
  o.stop(t + duration + 0.4);
  lfo.stop(t + duration + 0.4);
}

function knock(at: number, peak = 0.3) {
  const c = ac();
  if (!c) return;
  const src = noise(c, 0.08);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const g = c.createGain();
  env(c, g, at, 0.002, 0.01, 0.06, peak);
  src.connect(lp).connect(g).connect(c.destination);
  src.start(at);
}

/** Locked: two short metallic rattles. */
export function rattle() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  for (const dt of [0, 0.09]) {
    const src = noise(c, 0.05);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const g = c.createGain();
    env(c, g, t + dt, 0.001, 0.008, 0.04, 0.25);
    src.connect(hp).connect(g).connect(c.destination);
    src.start(t + dt);
  }
}

/** A key or clue goes into the pocket. */
export function pickup() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  [1320, 1760].forEach((f, i) => {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = c.createGain();
    env(c, g, t + i * 0.07, 0.005, 0.02, 0.35, 0.08);
    o.connect(g).connect(c.destination);
    o.start(t + i * 0.07);
    o.stop(t + i * 0.07 + 0.5);
  });
}

/** Code accepted / escaped. */
export function unlock() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  knock(t, 0.35);
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = c.createGain();
    env(c, g, t + 0.05 + i * 0.09, 0.01, 0.05, 0.6, 0.07);
    o.connect(g).connect(c.destination);
    o.start(t + 0.05 + i * 0.09);
    o.stop(t + 1.2);
  });
}
