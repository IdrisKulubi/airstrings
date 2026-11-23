// Strings: geometry, pluck detection, damped vibration and rendering.

let nextId = 1;

export class AirString {
  /** @param instrument preset name this string plays with (fixed for its lifetime) */
  constructor(a, b, midi, instrument, color) {
    this.id = nextId++;
    this.a = a;
    this.b = b;
    this.midi = midi;
    this.instrument = instrument;
    this.color = color;
    this.grabbed = false;
    this.doomed = 0; // 0..1 while a fist is about to delete this string
    this.amp = 0;       // current vibration amplitude (px)
    this.at = 0.5;      // where along the string it was plucked (0..1)
    this.t0 = 0;        // time of last pluck
    this.born = performance.now();
    this.lastPluckBy = new Map(); // finger id -> time (debounce)
  }

  get length() { return Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y); }

  /** Did the fingertip move across this string between two frames?
   *  Returns the crossing parameter t along the string (0..1) or null. */
  crossing(p0, p1) {
    const { a, b } = this;
    const r = { x: b.x - a.x, y: b.y - a.y };
    const s = { x: p1.x - p0.x, y: p1.y - p0.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < 1e-6) return null;
    const q = { x: p0.x - a.x, y: p0.y - a.y };
    const t = (q.x * s.y - q.y * s.x) / denom;
    const u = (q.x * r.y - q.y * r.x) / denom;
    if (t < 0.03 || t > 0.97 || u < 0 || u > 1) return null;
    return t;
  }

  distanceTo(p) {
    const { a, b } = this;
    const r = { x: b.x - a.x, y: b.y - a.y };
    const L2 = r.x * r.x + r.y * r.y || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * r.x + (p.y - a.y) * r.y) / L2));
    return Math.hypot(a.x + r.x * t - p.x, a.y + r.y * t - p.y);
  }

  pluck(t, strength, now) {
    this.at = t;
    this.t0 = now;
    this.amp = Math.min(6 + strength * 26, 34);
  }

  /** Current sideways displacement at the pluck point (damped sine). */
  displacement(now) {
    const dt = (now - this.t0) / 1000;
    if (this.amp <= 0 || dt > 3) return 0;
    const omega = 2 * Math.PI * (14 + (this.midi - 40) * 0.35); // visual wobble, not audio rate
    return this.amp * Math.exp(-dt / 0.45) * Math.sin(omega * dt);
  }

  energy(now) {
    const dt = (now - this.t0) / 1000;
    return this.amp > 0 ? Math.exp(-dt / 0.45) : 0;
  }

  draw(ctx, now) {
    const { a, b } = this;
    const L = this.length;
    const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    const d = this.displacement(now);
    const e = this.energy(now);
    // Control point placed so the curve peaks at the pluck point.
    const px = a.x + (b.x - a.x) * this.at + nx * d * 2;
    const py = a.y + (b.y - a.y) * this.at + ny * d * 2;
    const spawn = Math.min((now - this.born) / 250, 1);

    // Turns red and flickers while a fist is about to delete it.
    const color = this.doomed > 0 ? '#ff3b5c' : this.color;
    const flicker = this.doomed > 0 ? 0.55 + 0.45 * Math.sin(now / 40) : 1;

    ctx.save();
    ctx.globalAlpha = spawn * flicker;
    ctx.lineCap = 'round';

    // glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 + e * 30 + this.doomed * 25;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 + e * 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(px, py, b.x, b.y);
    ctx.stroke();

    // bright core
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // tick marks (like frets) along the string
    ctx.strokeStyle = color;
    ctx.globalAlpha = spawn * 0.55;
    const ticks = Math.max(4, Math.round(L / 45));
    for (let i = 1; i < ticks; i++) {
      const t = i / ticks;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      const h = i % 4 === 0 ? 9 : 5;
      ctx.beginPath();
      ctx.moveTo(x - nx * h, y - ny * h);
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    // end pegs (bigger + filled while an end is being dragged)
    ctx.globalAlpha = spawn;
    ctx.lineWidth = 1.5;
    for (const [key, p] of [['a', a], ['b', b]]) {
      const held = this.grabbed === key;
      ctx.beginPath();
      ctx.arc(p.x, p.y, held ? 9 : 4.5, 0, Math.PI * 2);
      if (held) { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.fill(); }
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Little sparks flying off a pluck. */
export class Sparks {
  constructor() { this.list = []; }

  burst(x, y, color, strength) {
    const n = 10 + Math.floor(strength * 30);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * (3 + strength * 7);
      this.list.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, color,
        decay: 0.015 + Math.random() * 0.03 });
    }
    if (this.list.length > 1500) this.list.splice(0, this.list.length - 1500);
  }

  step(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.list) {
      s.x += s.vx; s.y += s.vy;
      s.vx *= 0.95; s.vy = s.vy * 0.95 + 0.06;
      s.life -= s.decay;
      ctx.globalAlpha = Math.max(s.life, 0);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 2, s.y - s.vy * 2);
      ctx.stroke();
    }
    ctx.restore();
    this.list = this.list.filter((s) => s.life > 0);
  }
}
