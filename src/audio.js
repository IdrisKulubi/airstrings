// Plucked-string synth: Karplus-Strong rendered into a buffer per pluck.
// Cheap enough for dozens of plucks per second and sounds like a real string.

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export class StringSynth {
  constructor() {
    this.ctx = null;
    this.scaleName = 'pentatonic';
    this.root = 48; // C3
    this.cache = new Map();
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;

    // Light compression so many strings at once don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;

    // A short synthetic reverb tail for some space.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.2, 2.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.28;

    this.master.connect(comp);
    this.master.connect(this.reverb);
    this.reverb.connect(wet);
    wet.connect(comp);
    comp.connect(ctx.destination);
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

  cycleScale() {
    const names = Object.keys(SCALES);
    this.scaleName = names[(names.indexOf(this.scaleName) + 1) % names.length];
    return this.scaleName;
  }

  /** Map a string length (px) to a MIDI note snapped to the current scale.
   *  Shorter string → higher pitch (f ∝ 1/L), like a real instrument. */
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

  render(freq) {
    const key = freq.toFixed(2);
    if (this.cache.has(key)) return this.cache.get(key);
    const rate = this.ctx.sampleRate;
    const seconds = 2.5;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    const period = Math.max(2, Math.round(rate / freq));
    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
    // Higher notes decay a bit faster, like real strings.
    const damp = 0.996 - Math.min(freq / 20000, 0.01);
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const next = (idx + 1) % period;
      const v = damp * 0.5 * (ring[idx] + ring[next]);
      out[i] = ring[idx];
      ring[idx] = v;
      idx = next;
    }
    this.cache.set(key, buf);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return buf;
  }

  /** @param midi note  @param velocity 0..1  @param pan -1..1 */
  pluck(midi, velocity = 0.7, pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const src = ctx.createBufferSource();
    src.buffer = this.render(freq);

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1500 + velocity * 7000; // harder pluck = brighter

    const g = ctx.createGain();
    g.gain.value = 0.15 + velocity * 0.55;

    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));

    src.connect(tone).connect(g).connect(p).connect(this.master);
    src.start();
  }
}

export function midiName(m) {
  const n = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return n[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
