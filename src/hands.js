import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export async function createTracker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    return await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

/** One-Euro filter: smooths jitter when still, stays responsive when moving fast. */
class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.02, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
  }
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/** Keeps a stable, smoothed view of each hand (keyed by handedness). */
export class HandState {
  constructor(label) {
    this.label = label;
    this.filters = Array.from({ length: 21 }, () => [new OneEuro(), new OneEuro()]);
    this.pts = null;      // smoothed screen points [{x,y}]
    this.prevPts = null;  // last frame's points
    this.seen = 0;        // last time seen (ms)
    this.pinching = false;
    this.pinchStart = null;
    this.fistSince = 0;
    this.grab = null;
    this.consumed = false;
    this.fist = false;
    this.fistTarget = null;
  }

  update(rawPts, t) {
    this.prevPts = this.pts;
    this.pts = rawPts.map((p, i) => ({
      x: this.filters[i][0].filter(p.x, t),
      y: this.filters[i][1].filter(p.y, t),
    }));
    if (!this.prevPts || t - this.seen > 200) this.prevPts = this.pts;
    this.seen = t;
  }

  reset() {
    this.filters = Array.from({ length: 21 }, () => [new OneEuro(), new OneEuro()]);
    this.pts = this.prevPts = null;
    this.pinching = false;
    this.pinchStart = null;
    this.fistSince = 0;
    if (this.grab) this.grab.s.grabbed = false;
    this.grab = null;      // { s: AirString, end: 'a' | 'b' } while dragging a string end
    this.consumed = false; // pinch already used (e.g. finished a two-hand create)
    this.fist = false;
    this.fistTarget = null;
  }

  get size() {
    const p = this.pts;
    return Math.hypot(p[9].x - p[0].x, p[9].y - p[0].y) || 1;
  }

  get pinchPoint() {
    const p = this.pts;
    return { x: (p[4].x + p[8].x) / 2, y: (p[4].y + p[8].y) / 2 };
  }

  /** Pinch with hysteresis so it doesn't flicker on/off. */
  updatePinch() {
    const p = this.pts;
    const d = Math.hypot(p[4].x - p[8].x, p[4].y - p[8].y) / this.size;
    if (!this.pinching && d < 0.32) this.pinching = true;
    else if (this.pinching && d > 0.5) this.pinching = false;
    return this.pinching;
  }

  /** Centre of the palm (wrist + the four knuckles). */
  get palm() {
    const p = this.pts;
    const ids = [0, 5, 9, 13, 17];
    return {
      x: ids.reduce((s, i) => s + p[i].x, 0) / ids.length,
      y: ids.reduce((s, i) => s + p[i].y, 0) / ids.length,
    };
  }

  /** Forgiving fist test: at least 3 of the 4 fingers are curled.
   *  A finger counts as curled when its tip is closer to the wrist than its middle
   *  joint is (works at any hand angle), or the tip is simply tucked near the palm. */
  isFist() {
    const p = this.pts;
    const d = (i, j) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
    const palm = this.palm;
    const fingers = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, PIP joint]
    let curled = 0;
    for (const [tip, pip] of fingers) {
      const nearPalm = Math.hypot(p[tip].x - palm.x, p[tip].y - palm.y) / this.size < 0.9;
      if (d(tip, 0) < d(pip, 0) * 1.1 || nearPalm) curled++;
    }
    return curled >= 3;
  }
}
