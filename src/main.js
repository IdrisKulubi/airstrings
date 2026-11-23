import { createTracker, HandState, CONNECTIONS } from './hands.js';
import { StringSynth, PRESETS, midiName } from './audio.js';
import { AirString, Sparks } from './strings.js';

const video = document.getElementById('cam');
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const helpEl = document.getElementById('help');
const startEl = document.getElementById('start');
const goBtn = document.getElementById('go');

const synth = new StringSynth();
const sparks = new Sparks();
const strings = [];
const hands = new Map();
const FINGERTIPS = [8, 12]; // index + middle can pluck
const MAX_STRINGS = 24;
const GRAB_RADIUS = 45;     // px: pinch this close to a string end to grab it
const MIN_LENGTH = 50;      // px: shorter strings are not created / get removed
const FIST_HOLD_MS = 1000;       // hold a fist this long before the string is deleted
const FIST_GRACE_MS = 1200;      // no fist-delete right after a pinch/grab ends
const NEW_STRING_SAFE_MS = 1500; // freshly made strings can't be fist-deleted
const HAND_LOST_MS = 400;        // forget a hand after it's been missing this long
let nextHandId = 1;

let tracker = null;
let showHands = true;
let W = 0, H = 0, DPR = 1;
let lastVideoTime = -1;
let toast = { text: '', until: 0 };
let spawn = null; // two-hand creation in progress: { keys: [k1, k2], a, b }
const colorCount = {}; // per-instrument colour rotation

// ---------- layout ----------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const refLen = () => Math.min(W, H) * 0.9;
const spawnStartDist = () => Math.min(W, H) * 0.3; // how close the two pinches must start

/** Video is drawn "cover" + mirrored; this maps normalised landmarks to screen px. */
function videoRect() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  return { s, w: vw * s, h: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
function toScreen(lm, r) {
  return { x: r.ox + (1 - lm.x) * r.w, y: r.oy + lm.y * r.h };
}
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

function say(text, ms = 1400) { toast = { text, until: performance.now() + ms }; }

// ---------- string actions ----------
function addString(a, b) {
  if (dist(a, b) < MIN_LENGTH) return;
  const inst = synth.presetName;
  const pal = PRESETS[inst].palette;
  colorCount[inst] = (colorCount[inst] || 0) + 1;
  const s = new AirString({ ...a }, { ...b }, synth.noteForLength(dist(a, b), refLen()),
    inst, pal[(colorCount[inst] - 1) % pal.length]);
  strings.push(s);
  if (strings.length > MAX_STRINGS) strings.shift();
  s.pluck(0.5, 0.4, performance.now());
  synth.pluck(s.midi, 0.45, ((a.x + b.x) / 2 / W) * 2 - 1, s.instrument);
  say(`${PRESETS[inst].label} · ${midiName(s.midi)}`);
}

function removeString(s) {
  const i = strings.indexOf(s);
  if (i >= 0) strings.splice(i, 1);
  sparks.burst((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, s.color, 1);
}

function pluckString(s, t, strength, now, fromLoop = false) {
  s.pluck(t, strength, now);
  const x = s.a.x + (s.b.x - s.a.x) * t, y = s.a.y + (s.b.y - s.a.y) * t;
  sparks.burst(x, y, s.color, strength);
  synth.pluck(s.midi, strength, (x / W) * 2 - 1, s.instrument);
  if (!fromLoop) looper.record(s, t, strength, now);
}

/** Check one moving point (fingertip or mouse) against every string. */
function testPluck(id, p0, p1, now) {
  const speed = dist(p0, p1);
  if (speed < 2) return;
  const strength = Math.min(speed / 60, 1);
  for (const s of strings) {
    if (s.grabbed) continue;
    const t = s.crossing(p0, p1);
    if (t === null) continue;
    const last = s.lastPluckBy.get(id) || 0;
    if (now - last < 110) continue;
    s.lastPluckBy.set(id, now);
    pluckString(s, t, strength, now);
  }
}

/** String closest to the fist, within a radius that scales with hand size. */
function fistTarget(h, now) {
  const palm = h.palm;
  const radius = Math.max(130, h.size * 2.2);
  let best = null, bestD = radius;
  for (const s of strings) {
    if (s.grabbed || now - s.born < NEW_STRING_SAFE_MS) continue;
    const d = s.distanceTo(palm);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Nearest free string end within GRAB_RADIUS of p. */
function findEnd(p) {
  let best = null, bestD = GRAB_RADIUS;
  for (const s of strings) {
    if (s.grabbed) continue;
    for (const end of ['a', 'b']) {
      const d = dist(s[end], p);
      if (d < bestD) { bestD = d; best = { s, end }; }
    }
  }
  return best;
}

function startGrab(g) {
  g.s.grabbed = g.end;
  return g;
}

/** Move a grabbed end; retune live and give an audible tick whenever the note changes. */
function moveGrab(g, p, now) {
  g.s[g.end] = { x: p.x, y: p.y };
  const midi = synth.noteForLength(g.s.length, refLen());
  if (midi !== g.s.midi) {
    g.s.midi = midi;
    g.s.pluck(0.5, 0.2, now);
    synth.pluck(midi, 0.3, (p.x / W) * 2 - 1, g.s.instrument);
  }
}

function endGrab(g) {
  g.s.grabbed = false;
  if (g.s.length < MIN_LENGTH) { removeString(g.s); say('removed'); }
  else say(midiName(g.s.midi));
}

// ---------- loop recorder ----------
// R: record → R: start looping → R: overdub → R: back to playing.  L: clear loop.
const looper = {
  state: 'idle', // idle | rec | play | dub
  events: [],
  len: 0,
  start: 0,
  lastPhase: 0,

  toggle(now) {
    if (this.state === 'idle') {
      this.events = []; this.start = now; this.state = 'rec'; say('● recording loop');
    } else if (this.state === 'rec') {
      if (!this.events.length) { this.state = 'idle'; say('loop cancelled'); return; }
      this.len = Math.max(now - this.start, 500);
      this.start = now; this.lastPhase = 0; this.state = 'play'; say('▶ looping');
    } else if (this.state === 'play') {
      this.state = 'dub'; say('● overdub');
    } else {
      this.state = 'play'; say('▶ looping');
    }
  },

  clear() { this.state = 'idle'; this.events = []; say('loop cleared'); },

  record(s, at, strength, now) {
    if (this.state === 'rec') {
      this.events.push({ t: now - this.start, id: s.id, at, strength });
    } else if (this.state === 'dub') {
      // `fresh` stops it re-triggering until the loop wraps around once.
      this.events.push({ t: (now - this.start) % this.len, id: s.id, at, strength, fresh: true });
    }
  },

  tick(now) {
    if (this.state !== 'play' && this.state !== 'dub') return;
    const phase = (now - this.start) % this.len;
    const wrapped = phase < this.lastPhase;
    if (wrapped) for (const e of this.events) e.fresh = false;
    for (const e of this.events) {
      if (e.fresh) continue;
      const hit = wrapped ? (e.t > this.lastPhase || e.t <= phase) : (e.t > this.lastPhase && e.t <= phase);
      if (!hit) continue;
      const s = strings.find((x) => x.id === e.id);
      if (s) pluckString(s, e.at, e.strength, now, true);
    }
    this.lastPhase = phase;
  },

  progress(now) {
    if (this.state === 'rec') return null;
    return ((now - this.start) % this.len) / this.len;
  },
};

// ---------- clip recording ----------
let clip = null;
function toggleClip() {
  if (clip) { clip.rec.stop(); return; }
  if (!window.MediaRecorder || !canvas.captureStream) { say('Recording not supported here'); return; }
  const stream = canvas.captureStream(30);
  synth.recDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `airstrings-${new Date().toISOString().replace(/[:.]/g, '-')}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    clip = null;
    say('clip saved');
  };
  rec.start(250);
  clip = { rec, start: performance.now() };
  say('● recording clip (V to stop)');
}

// ---------- presets ----------
const PRESET_KEYS = Object.keys(PRESETS); // 1..5
/** Pick the instrument for NEW strings; strings already on stage keep their own. */
function applyPreset(name) {
  synth.setPreset(name);
  say(`next strings: ${PRESETS[name].label}`);
}

// ---------- hands ----------
/** Match this frame's detections to known hands by wrist position, not by MediaPipe's
 *  Left/Right label (which can flip or duplicate while hands move fast). */
function matchHands(dets, now) {
  const known = [...hands.values()].filter((h) => h.pts && now - h.seen < HAND_LOST_MS);
  const pairs = [];
  dets.forEach((d, i) => known.forEach((h) => pairs.push({ i, h, dd: dist(d[0], h.pts[0]) })));
  pairs.sort((x, y) => x.dd - y.dd);
  const usedDet = new Set(), usedHand = new Set(), out = [];
  for (const { i, h, dd } of pairs) {
    if (usedDet.has(i) || usedHand.has(h) || dd > Math.max(W, H) * 0.35) continue;
    usedDet.add(i); usedHand.add(h); out.push([h, dets[i]]);
  }
  dets.forEach((d, i) => {
    if (usedDet.has(i)) return;
    const h = new HandState(`hand${nextHandId++}`);
    hands.set(h.label, h);
    out.push([h, d]);
  });
  return out;
}

function processHands(result, now) {
  const r = videoRect();
  for (const s of strings) s.doomed = 0;
  const dets = (result.landmarks || []).map((lms) => lms.map((lm) => toScreen(lm, r)));
  const seen = new Set();
  for (const [h, pts] of matchHands(dets, now)) { h.update(pts, now); seen.add(h); }

  // Forget hands that have been gone a while. If one was drawing a string, keep the
  // string where it was last seen instead of throwing it away.
  for (const [key, h] of hands) {
    if (seen.has(h) || now - h.seen <= HAND_LOST_MS) continue;
    if (spawn?.keys.includes(key)) { addString(spawn.a, spawn.b); spawn = null; }
    h.reset();
    hands.delete(key);
  }

  // 1) pinch / fist state
  const active = [...seen];
  for (const h of active) {
    const was = h.pinching;
    // A hand that is drawing a string or holding an end is never treated as a fist,
    // so a sloppy fist-ish shape mid-pull can't cancel anything.
    const busy = h.grab || spawn?.keys.includes(h.label);
    // Closing into a fist passes through a pinch-like shape (thumb meets index), so a
    // folded index finger overrides a pinch — otherwise the fist gets stuck as a pinch.
    const rawFist = !busy && h.isFist();
    h.fistFrames = rawFist ? h.fistFrames + 1 : 0;
    h.fist = h.fistFrames >= 5; // must be held steadily for a few frames
    if (!h.fist) h.fistDone = false;
    let pinching;
    if (rawFist) { pinching = h.pinching = false; h.offFrames = 0; }
    else pinching = h.updatePinch();
    h.justPinched = pinching && !was;
    h.justReleased = !pinching && was;
    if (h.justReleased && !rawFist) h.lastActionAt = now;
  }

  // 2) two-hand string creation in progress
  if (spawn) {
    const [h1, h2] = spawn.keys.map((k) => hands.get(k));
    if (h1?.pinching && seen.has(h1)) spawn.a = h1.pinchPoint;
    if (h2?.pinching && seen.has(h2)) spawn.b = h2.pinchPoint;
    const released = (h) => h && seen.has(h) && !h.pinching;
    if (released(h1) || released(h2)) {
      addString(spawn.a, spawn.b);
      for (const h of [h1, h2]) if (h?.pinching) h.consumed = true; // other hand still pinched
      spawn = null;
    }
  }

  // 3) per-hand: grab ends, release, pluck, fist
  for (const h of active) {
    if (h.justReleased) {
      if (h.grab) { endGrab(h.grab); h.grab = null; }
      h.consumed = false;
    }
    if (h.justPinched && !spawn) {
      const g = findEnd(h.pinchPoint);
      if (g) h.grab = startGrab(g);
      else h.pinchStart = h.pinchPoint;
    }
    if (h.grab) moveGrab(h.grab, h.pinchPoint, now);

    if (!h.pinching) {
      for (const tip of FINGERTIPS) testPluck(`${h.label}:${tip}`, h.prevPts[tip], h.pts[tip], now);
    }

    // Fist delete: hold a steady fist for ~1 s; the target turns red while it counts down.
    // One string per fist — open the hand and close it again to delete another.
    const canDelete = h.fist && !h.fistDone && now - h.lastActionAt > FIST_GRACE_MS;
    const target = canDelete ? fistTarget(h, now) : null;
    if (target !== h.fistTarget) { h.fistTarget = target; h.fistSince = now; }
    if (target) {
      target.doomed = Math.min((now - h.fistSince) / FIST_HOLD_MS, 1);
      if (target.doomed >= 1) {
        removeString(target);
        say('deleted');
        h.fistTarget = null;
        h.fistDone = true;
      }
    }
  }

  // 4) start a new string when two free pinches meet in the middle
  if (!spawn) {
    const free = active.filter((h) => h.pinching && !h.grab && !h.consumed);
    if (free.length >= 2 && dist(free[0].pinchPoint, free[1].pinchPoint) < spawnStartDist()) {
      spawn = { keys: [free[0].label, free[1].label], a: free[0].pinchPoint, b: free[1].pinchPoint };
    }
  }
}

// ---------- drawing ----------
function drawVideo() {
  if (!video.videoWidth) return;
  const r = videoRect();
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, W - r.ox - r.w, r.oy, r.w, r.h);
  ctx.restore();
  ctx.fillStyle = 'rgba(5, 6, 14, 0.45)';
  ctx.fillRect(0, 0, W, H);
}

function drawHand(h) {
  const p = h.pts;
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#3dff6e';
  ctx.beginPath();
  for (const [i, j] of CONNECTIONS) { ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(p[j].x, p[j].y); }
  ctx.stroke();
  ctx.fillStyle = '#e01b2f';
  for (const q of p) { ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); }
  for (const tip of FINGERTIPS) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p[tip].x, p[tip].y, 7, 0, Math.PI * 2); ctx.stroke();
  }
  // What the app thinks this hand is doing — makes gestures easy to debug.
  let label = '', color = '#e8ecff';
  if (h.fist) { label = 'FIST'; color = '#ff5370'; }
  else if (h.grab) { label = 'HOLDING END'; color = '#7df9ff'; }
  else if (spawn?.keys.includes(h.label)) { label = 'PULL APART'; color = '#7df9ff'; }
  else if (h.pinching && !h.consumed) {
    const other = [...hands.values()].some((o) => o !== h && o.pinching && performance.now() - o.seen < 300);
    label = other ? 'BRING PINCHES TOGETHER' : 'PINCH · now pinch the other hand';
    color = '#f4ff7a';
  }
  if (label) {
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(label, p[0].x, p[0].y + 26);
  }
  ctx.restore();
}

function drawPreview(a, b) {
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(125, 249, 255, 0.85)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#7df9ff';
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.setLineDash([]);
  for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke(); }
  const L = dist(a, b);
  if (L > MIN_LENGTH) noteLabel(synth.noteForLength(L, refLen()), (a.x + b.x) / 2, (a.y + b.y) / 2 - 16);
  ctx.restore();
}

function noteLabel(midi, x, y) {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#7df9ff';
  ctx.font = '700 14px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(midiName(midi), x, y);
  ctx.restore();
}

function drawToast(now) {
  if (now > toast.until) return;
  ctx.save();
  ctx.globalAlpha = Math.min((toast.until - now) / 300, 1);
  ctx.fillStyle = '#e8ecff';
  ctx.font = '700 22px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(toast.text, W / 2, 80);
  ctx.restore();
}

function drawIndicators(now) {
  const x = W / 2;
  ctx.save();
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  if (looper.state !== 'idle') {
    const recording = looper.state === 'rec' || looper.state === 'dub';
    const color = recording ? '#ff5370' : '#7dffb0';
    const prog = looper.progress(now);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x - 40, 28, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (prog === null) ctx.arc(x - 40, 28, 11, 0, Math.PI * 2 * ((now / 1000) % 1));
    else ctx.arc(x - 40, 28, 11, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText({ rec: 'REC', play: 'LOOP', dub: 'DUB' }[looper.state], x - 22, 32);
  }
  if (clip) {
    const secs = Math.floor((now - clip.start) / 1000);
    ctx.fillStyle = now % 1000 < 600 ? '#ff5370' : 'rgba(255,83,112,0.4)';
    ctx.beginPath(); ctx.arc(x + 40, 28, 6, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, x + 52, 32);
  }
  ctx.restore();
}

// ---------- main loop ----------
let frames = 0, fpsT = performance.now(), fps = 0;
function loop() {
  const now = performance.now();

  looper.tick(now); // before input so freshly-recorded plucks never double-fire
  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processHands(tracker.detectForVideo(video, now), now);
  }
  if (mouse.grab) moveGrab(mouse.grab, mouse.pos, now);

  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  drawVideo();

  for (const s of strings) s.draw(ctx, now);
  sparks.step(ctx);

  for (const h of hands.values()) {
    if (!h.pts || now - h.seen > 300) continue;
    if (showHands) drawHand(h);
    if (h.grab) noteLabel(h.grab.s.midi, h.pinchPoint.x, h.pinchPoint.y - 22);
  }
  if (spawn) drawPreview(spawn.a, spawn.b);
  if (mouse.down && mouse.start) drawPreview(mouse.start, mouse.pos);
  if (mouse.grab) noteLabel(mouse.grab.s.midi, mouse.pos.x, mouse.pos.y - 22);
  drawIndicators(now);
  drawToast(now);

  frames++;
  if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; }
  statusEl.textContent =
    `${fps} fps · ${strings.length} strings · next: ${PRESETS[synth.presetName].label} · ${synth.scaleName}` +
    (tracker ? '' : ' · mouse mode');
  requestAnimationFrame(loop);
}

// ---------- mouse / touch fallback ----------
// Drag from empty space = new string. Drag from a string end = resize/retune. Move across = pluck.
const mouse = { down: false, start: null, grab: null, pos: { x: 0, y: 0 }, prev: null };
canvas.addEventListener('pointerdown', (e) => {
  const p = { x: e.clientX, y: e.clientY };
  mouse.pos = p;
  const g = findEnd(p);
  if (g) { mouse.grab = startGrab(g); return; }
  mouse.down = true;
  mouse.start = { ...p };
});
canvas.addEventListener('pointermove', (e) => {
  const p = { x: e.clientX, y: e.clientY };
  if (!mouse.down && !mouse.grab && mouse.prev) testPluck('mouse', mouse.prev, p, performance.now());
  mouse.prev = p;
  mouse.pos = p;
});
window.addEventListener('pointerup', () => {
  if (mouse.grab) { endGrab(mouse.grab); mouse.grab = null; }
  if (mouse.down && mouse.start) addString(mouse.start, mouse.pos);
  mouse.down = false;
  mouse.start = null;
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  const now = performance.now();
  if (k >= '1' && k <= String(PRESET_KEYS.length)) applyPreset(PRESET_KEYS[Number(k) - 1]);
  else if (k === 'z') { strings.pop(); say('undo'); }
  else if (k === 'c') { strings.length = 0; say('cleared'); }
  else if (k === 'h') { showHands = !showHands; }
  else if (k === 'r') looper.toggle(now);
  else if (k === 'l') looper.clear();
  else if (k === 'v') toggleClip();
  else if (k === 's') {
    synth.cycleScale();
    for (const s of strings) s.midi = synth.noteForLength(s.length, refLen());
    say(`scale: ${synth.scaleName}`);
  }
  else if (k === '?' || k === '/') helpEl.classList.toggle('hidden');
});

// ---------- start ----------
async function start(useCamera) {
  goBtn.disabled = true;
  goBtn.textContent = 'Loading…';
  await synth.init();
  if (useCamera) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      tracker = await createTracker();
    } catch (err) {
      console.error(err);
      say('Camera / tracker unavailable — using mouse mode', 4000);
    }
  }
  startEl.classList.add('gone');
  helpEl.classList.remove('hidden');
  requestAnimationFrame(loop);
}

// ?mouse skips the camera entirely
const mouseOnly = new URLSearchParams(location.search).has('mouse');
if (mouseOnly) goBtn.textContent = 'Start (mouse mode)';
goBtn.addEventListener('click', () => start(!mouseOnly));

// Expose a tiny handle for debugging in the console.
window.airstrings = { strings, looper, synth, processHands, getSpawn: () => spawn };
