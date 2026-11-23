import { createTracker, HandState, CONNECTIONS } from './hands.js';
import { StringSynth, midiName } from './audio.js';
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

let tracker = null;
let showHands = true;
let W = 0, H = 0, DPR = 1;
let lastVideoTime = -1;
let toast = { text: '', until: 0 };

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

/** Video is drawn "cover" + mirrored; this maps normalised landmarks to screen px. */
function videoRect() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  return { s, w: vw * s, h: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
function toScreen(lm, r) {
  return { x: r.ox + (1 - lm.x) * r.w, y: r.oy + lm.y * r.h };
}

function say(text, ms = 1400) { toast = { text, until: performance.now() + ms }; }

// ---------- string actions ----------
function addString(a, b) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 50) return;
  const midi = synth.noteForLength(L, Math.min(W, H) * 0.9);
  const s = new AirString(a, b, midi);
  strings.push(s);
  if (strings.length > MAX_STRINGS) strings.shift();
  s.pluck(0.5, 0.4, performance.now());
  synth.pluck(midi, 0.45, ((a.x + b.x) / 2 / W) * 2 - 1);
  say(midiName(midi));
}

function pluckString(s, t, strength, now) {
  s.pluck(t, strength, now);
  const x = s.a.x + (s.b.x - s.a.x) * t, y = s.a.y + (s.b.y - s.a.y) * t;
  sparks.burst(x, y, s.color, strength);
  synth.pluck(s.midi, strength, (x / W) * 2 - 1);
}

/** Check one moving point (fingertip or mouse) against every string. */
function testPluck(id, p0, p1, now) {
  const speed = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (speed < 2) return;
  const strength = Math.min(speed / 60, 1);
  for (const s of strings) {
    const t = s.crossing(p0, p1);
    if (t === null) continue;
    const last = s.lastPluckBy.get(id) || 0;
    if (now - last < 110) continue;
    s.lastPluckBy.set(id, now);
    pluckString(s, t, strength, now);
  }
}

function deleteNearest(p) {
  let best = -1, bestD = 90;
  strings.forEach((s, i) => {
    const d = s.distanceTo(p);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    const [s] = strings.splice(best, 1);
    sparks.burst((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, s.color, 1);
    say('deleted');
  }
}

// ---------- hands ----------
function processHands(result, now) {
  const r = videoRect();
  const seen = new Set();
  (result.landmarks || []).forEach((lms, i) => {
    let key = result.handednesses?.[i]?.[0]?.categoryName || `h${i}`;
    if (seen.has(key)) key += i;
    seen.add(key);
    if (!hands.has(key)) hands.set(key, new HandState(key));
    hands.get(key).update(lms.map((lm) => toScreen(lm, r)), now);
  });

  for (const [key, h] of hands) {
    if (!seen.has(key)) {
      if (now - h.seen > 300) h.reset();
      continue;
    }
    const wasPinching = h.pinching;
    const pinching = h.updatePinch();
    if (pinching && !wasPinching) h.pinchStart = h.pinchPoint;
    if (!pinching && wasPinching && h.pinchStart) {
      addString(h.pinchStart, h.pinchPoint);
      h.pinchStart = null;
    }

    if (!pinching) {
      for (const tip of FINGERTIPS) testPluck(`${key}:${tip}`, h.prevPts[tip], h.pts[tip], now);
    }

    if (h.isFist()) {
      if (!h.fistSince) h.fistSince = now;
      else if (now - h.fistSince > 700) {
        deleteNearest(h.pts[9]);
        h.fistSince = now + 400; // short cool-down
      }
    } else {
      h.fistSince = 0;
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
  ctx.fillStyle = 'rgba(5, 6, 14, 0.45)'; // darken so strings pop
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
  if (h.fistSince && performance.now() > h.fistSince) {
    const k = Math.min((performance.now() - h.fistSince) / 700, 1);
    ctx.strokeStyle = '#ff5370';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p[9].x, p[9].y, 30, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPreview(a, b) {
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(125, 249, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#7df9ff';
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.setLineDash([]);
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L > 50) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#7df9ff';
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.fillText(midiName(synth.noteForLength(L, Math.min(W, H) * 0.9)), b.x + 10, b.y - 10);
  }
  ctx.restore();
}

function drawToast(now) {
  if (now > toast.until) return;
  ctx.save();
  ctx.globalAlpha = Math.min((toast.until - now) / 300, 1);
  ctx.fillStyle = '#e8ecff';
  ctx.font = '700 22px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(toast.text, W / 2, H - 40);
  ctx.restore();
}

// ---------- main loop ----------
let frames = 0, fpsT = performance.now(), fps = 0;
function loop() {
  const now = performance.now();

  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processHands(tracker.detectForVideo(video, now), now);
  }

  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  drawVideo();

  for (const s of strings) s.draw(ctx, now);
  sparks.step(ctx);

  for (const h of hands.values()) {
    if (!h.pts || now - h.seen > 300) continue;
    if (showHands) drawHand(h);
    if (h.pinching && h.pinchStart) drawPreview(h.pinchStart, h.pinchPoint);
  }
  if (mouse.down && mouse.start) drawPreview(mouse.start, mouse.pos);
  drawToast(now);

  frames++;
  if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; }
  statusEl.textContent =
    `${fps} fps · ${strings.length} strings · ${synth.scaleName}` + (tracker ? '' : ' · mouse mode');
  requestAnimationFrame(loop);
}

// ---------- mouse / touch fallback (also handy for testing) ----------
const mouse = { down: false, start: null, pos: { x: 0, y: 0 }, prev: null };
canvas.addEventListener('pointerdown', (e) => {
  mouse.down = true;
  mouse.start = { x: e.clientX, y: e.clientY };
  mouse.pos = { ...mouse.start };
});
canvas.addEventListener('pointermove', (e) => {
  const p = { x: e.clientX, y: e.clientY };
  if (!mouse.down && mouse.prev) testPluck('mouse', mouse.prev, p, performance.now());
  mouse.prev = p;
  mouse.pos = p;
});
window.addEventListener('pointerup', () => {
  if (mouse.down && mouse.start) addString(mouse.start, mouse.pos);
  mouse.down = false;
  mouse.start = null;
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'z') { strings.pop(); say('undo'); }
  else if (k === 'c') { strings.length = 0; say('cleared'); }
  else if (k === 'h') { showHands = !showHands; }
  else if (k === 's') {
    synth.cycleScale();
    for (const s of strings) s.midi = synth.noteForLength(s.length, Math.min(W, H) * 0.9);
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
