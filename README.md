# AirStrings

Draw glowing strings in the air with your hands, then pluck them with your fingertips to play music.
Runs entirely in the browser with webcam hand tracking. No server, no GPU, and no video leaves your device.

## How to play

| Gesture | Action |
|---|---|
| **Pinch** thumb + index, drag, release | Create a string between the two points |
| **Swipe** index or middle fingertip across a string | Pluck it (faster swipe = louder, brighter) |
| **Hold a fist** near a string (~0.7 s) | Delete that string |

Shorter strings play higher notes (pitch ∝ 1/length), snapped to a musical scale so it always sounds good.

Keyboard: `Z` undo · `C` clear all · `S` cycle scale (pentatonic / major / minor / blues / chromatic) · `H` toggle hand skeleton · `?` help

No webcam? Open with `?mouse` and use the mouse: drag to draw a string, move across a string to pluck it.

## Run it

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL and click **Start camera**. Camera access needs `localhost` or HTTPS.

## How it works

- **Hand tracking**: [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) gives 21 landmarks per hand, up to 2 hands. A One-Euro filter removes jitter.
- **Pinch detection**: thumb-tip ↔ index-tip distance, normalised by hand size, with hysteresis.
- **Pluck detection**: segment intersection between the fingertip's motion this frame and each string.
- **Sound**: Karplus-Strong plucked-string synthesis in the Web Audio API, with a velocity-controlled low-pass filter, stereo pan by screen position, and a small convolution reverb.
- **Visuals**: Canvas 2D. Strings vibrate as a damped sine `A·e^(-t/τ)·sin(ωt)` around the pluck point, with glow and spark particles.

## Roadmap

- [ ] Instrument presets (harp, guitar, kalimba, synth)
- [ ] Loop recorder
- [ ] Two-hand stretch to retune a string
- [ ] Record and share clips (MediaRecorder)
- [ ] WebGL bloom renderer
- [ ] Multiplayer jam over WebRTC

## License

MIT
