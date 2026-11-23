// Sound engine: Karplus-Strong strings, a subtractive synth pluck and simple drums,
// selectable as instrument presets. Also exposes a MediaStream for clip recording.

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const PRESETS = {
  harp: {
    label: 'Harp', kind: 'ks', damp: 0.9975, soft: 0, bright: 1.0, reverb: 0.32,
    palette: ['#ffffff', '#ff8fd8', '#7df9ff', '#f4ff7a', '#b48cff', '#7dffb0', '#ffb36b'],
  },
  guitar: {
    label: 'Guitar', kind: 'ks', damp: 0.994, soft: 1, bright: 0.6, reverb: 0.18, body: 1,
    palette: ['#ffcf8a', '#ff9f5a', '#ffe7c2', '#e8a76a', '#ffd36b', '#f7b98f'],
  },
  kalimba: {
    label: 'Kalimba', kind: 'ks', damp: 0.984, soft: 3, bright: 0.45, reverb: 0.3,
    palette: ['#9fffe0', '#7dffb0', '#c6ffa0', '#7df9ff', '#e2fff4'],
  },
  synth: {
    label: 'Synth', kind: 'osc', reverb: 0.25,
    palette: ['#ff4fd8', '#8a5cff', '#4fd2ff', '#ff6b9e', '#c86bff'],
  },
  drums: {
    label: 'Drums', kind: 'drum', reverb: 0.1,
    palette: ['#ff5370', '#ffcb6b', '#f78c6c', '#ff9cac', '#fff0a0'],
  },
};

export class StringSynth {
  constructor() {
    this.ctx = null;
    this.scaleName = 'pentatonic';
    this.presetName = 'harp';
    this.root = 48; // C3
    this.cache = new Map();
  }

  get preset() { return PRESETS[this.presetName]; }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.2, 2.5);
    this.wet = ctx.createGain();
    this.wet.gain.value = this.preset.reverb;

    this.master.connect(comp);
    this.master.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(comp);
    comp.connect(ctx.destination);

    // Tap for clip recording.
    this.recDest = ctx.createMediaStreamDestination();
    comp.connect(this.recDest);

    this.noise = this.makeNoise(1);
    await ctx.resume();
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setPreset(name) {
    this.presetName = name;
    if (this.wet) this.wet.gain.setTargetAtTime(this.preset.reverb, this.ctx.currentTime, 0.05);
  }

  cycleScale() {
    const names = Object.keys(SCALES);
    this.scaleName = names[(names.indexOf(this.scaleName) + 1) % names.length];
    return this.scaleName;
  }

  /** String length (px) → MIDI note snapped to the scale. Shorter = higher (f ∝ 1/L). */
  noteForLength(lengthPx, refPx) {
    const semis = 12 * Math.log2(refPx / Math.max(lengthPx, 20));
    let midi = this.root + 12 + semis;
    midi = Math.min(Math.max(midi, 36), 96);
    const scale = SCALES[this.scaleName];
    const rel = midi - this.root;
    const oct = Math.floor(rel / 12);
    const within = rel - oct * 12;
    let best = scale[0], bestD = Infinity;
    for (const s of [...scale, 12]) {
      const d = Math.abs(s - within);
      if (d < bestD) { bestD = d; best = s; }
    }
    return this.root + oct * 12 + best;
  }

  /** Karplus-Strong buffer. `soft` passes of smoothing on the excitation = mellower attack. */
  renderKS(freq, p) {
    const key = `${this.presetName}:${freq.toFixed(2)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * 2.5);
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    const period = Math.max(2, Math.round(rate / freq));
    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
    for (let pass = 0; pass < p.soft; pass++) {
      for (let i = 1; i < period; i++) ring[i] = 0.5 * (ring[i] + ring[i - 1]);
    }
    const damp = p.damp - Math.min(freq / 20000, 0.01);
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const next = (idx + 1) % period;
      const v = damp * 0.5 * (ring[idx] + ring[next]);
      out[i] = ring[idx];
      ring[idx] = v;
      idx = next;
    }
    // normalise (soft excitations come out quieter)
    let peak = 0;
    for (let i = 0; i < Math.min(len, 4000); i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) for (let i = 0; i < len; i++) out[i] /= peak;
    this.cache.set(key, buf);
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
    return buf;
  }

  /** @param midi note  @param velocity 0..1  @param pan -1..1 */
  pluck(midi, velocity = 0.7, pan = 0) {
    if (!this.ctx) return;
    const p = this.preset;
    const out = this.ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(this.master);
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    if (p.kind === 'ks') this.playKS(freq, velocity, p, out);
    else if (p.kind === 'osc') this.playSynth(freq, velocity, out);
    else this.playDrum(midi, velocity, out);
  }

  playKS(freq, velocity, p, out) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.renderKS(freq, p);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1200 + velocity * 8000 * p.bright;
    const g = ctx.createGain();
    g.gain.value = (0.12 + velocity * 0.45);
    let node = src.connect(tone);
    if (p.body) {
      const body = ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 210;
      body.Q.value = 1.1;
      body.gain.value = 7;
      node = node.connect(body);
    }
    node.connect(g).connect(out);
    src.start();
  }

  playSynth(freq, velocity, out) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square';
    o1.frequency.value = freq; o2.frequency.value = freq * 1.004;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 8;
    f.frequency.setValueAtTime(800 + velocity * 7000, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 + velocity * 0.25, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o1.connect(f); o2.connect(f); f.connect(g).connect(out);
    o1.start(t); o2.start(t); o1.stop(t + 1); o2.stop(t + 1);
  }

  /** Low notes → kick, middle → snare, high → hat. */
  playDrum(midi, velocity, out) {
    const ctx = this.ctx, t = ctx.currentTime;
    const v = 0.3 + velocity * 0.7;
    if (midi < 56) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const start = 110 + (midi - 36) * 4;
      o.frequency.setValueAtTime(start, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.5);
    } else {
      const isHat = midi >= 72;
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = isHat ? 'highpass' : 'bandpass';
      f.frequency.value = isHat ? 6000 + (midi - 72) * 150 : 1500 + (midi - 56) * 60;
      const g = ctx.createGain();
      const dur = isHat ? 0.07 : 0.2;
      g.gain.setValueAtTime(v * (isHat ? 0.5 : 0.8), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f).connect(g).connect(out);
      n.start(t); n.stop(t + dur + 0.02);
      if (!isHat) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.frequency.value = 190;
        og.gain.setValueAtTime(v * 0.4, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        o.connect(og).connect(out);
        o.start(t); o.stop(t + 0.15);
      }
    }
  }
}

export function midiName(m) {
  const n = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return n[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
