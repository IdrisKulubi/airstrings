# AirStrings

Draw glowing strings in the air with your hands, then pluck them with your fingertips to play music.
Runs entirely in the browser with webcam hand tracking. No server, no GPU, and no video leaves your device.

## How to play

| Gesture | Action |
|---|---|
| **Pinch with both hands together** in the middle, pull apart, release | Create a string. Where each pinch lets go becomes that end of the string |
| **Pinch a string's end** and drag in or out | Shorten or stretch it. The pitch changes live as you move |
| **Swipe** index or middle fingertip across a string | Pluck it (faster swipe = louder, brighter) |
| **Make a fist** near a string | The nearest string turns red and is deleted after ~0.35 s. Keep the fist closed to delete the next one |

Shorter strings play higher notes (pitch ∝ 1/length), snapped to a musical scale so it always sounds good.
Drag an end until the string is very short and it is removed.

### Keyboard

| Key | Action |
|---|---|
| `1`–`4` | Instrument for **new** strings: harp · guitar · kalimba · synth. Existing strings keep their own instrument, so you can mix them |
| `R` | Loop: record → play → overdub → play |
| `L` | Clear the loop |
| `V` | Start/stop recording a video clip (with audio), saved as `.webm` |
| `S` | Cycle scale (pentatonic / major / minor / blues / chromatic) |
| `Z` / `C` | Undo last string / clear all |
| `H` / `?` | Toggle hand skeleton / help |

No webcam? Open with `?mouse`: drag from empty space to draw a string, drag a string's end to retune it, and move across a string to pluck it.

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

- [x] Two-hand pinch-and-pull string creation
- [x] Grab a string end to resize and retune it live
- [x] Per-string instruments (harp, guitar, kalimba, synth) that can be mixed on stage
- [x] Loop recorder with overdub
- [x] Record clips with audio (MediaRecorder)
- [ ] WebGL bloom renderer
- [ ] String layout templates + save/share via link
- [ ] Deploy (HTTPS) so it works on phones
- [ ] Multiplayer jam over WebRTC

## License

MIT
