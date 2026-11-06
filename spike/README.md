# Spike: Signalsmith Stretch in place of SoundTouch

Branch `spike/signalsmith`. Question: should the worklet that transposes (and
compensates tempo while transposing) be [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/)
(`signalsmith-stretch` 1.3.2, MIT, C++ → WASM) instead of SoundTouch's WSOLA?

## What's here

| Path                                         | What                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/shifters.ts`                            | One `Shifter` interface, two implementations. The Signalsmith one is a thin port-protocol client, not the package's factory, so the page gets no 114 KB of WASM and no Blob URL.                                                                                         |
| `lib/audioEngine.ts`                         | Builds the shifter for the selected engine and **swaps it live** (`syncShifter`) in the same context. The captured element is untouched; only the node between source and destination changes. The worklet is paused while bypassed.                                     |
| `lib/audioQuality.ts` → options page         | `engine: 'soundtouch' \| 'signalsmith'` rides along with the quality knobs: storage, content, `ApplyMessage`, injected. Switch it in **Options → Audio Quality → Engine**, live on open videos.                                                                          |
| `modules/signalsmith-processor.ts`           | Copies the package's self-registering worklet file to `signalsmith-processor.js` (web-accessible).                                                                                                                                                                       |
| `spike/signalsmithSim.ts`                    | Drives the **real** Signalsmith processor (WASM included) offline in Node: stubs `AudioWorkletProcessor`/`registerProcessor`, imports the module, and calls `process()` per quantum.                                                                                     |
| `spike/compare.test.ts` → `spike/RESULTS.md` | Offline A/B against the current SoundTouch pipeline (`bun run spike:compare`).                                                                                                                                                                                           |
| `spike/browser/`                             | Real-browser checks (Chromium, via the `spike-bench` launch config): `index.html` render throughput, `wrapper.html` checks that `lib/shifters.ts` lands on the right pitch for both engines. Run `bun run build` and copy the worklet files in first (see `.gitignore`). |

## Results

Offline, at 48 kHz, on 7 settings from −12 to +12 st and 0.75× to 1.5×. Full table in `RESULTS.md`.

| engine                                   | latency    | tone purity | triad purity | click smear | CPU per quantum p99 / max |
| ---------------------------------------- | ---------- | ----------- | ------------ | ----------- | ------------------------- |
| SoundTouch (current)                     | 111–153 ms | 23.7 dB     | 11.0 dB      | 16.8 %      | 146 / 275 µs              |
| Signalsmith default (120 ms)             | 109–120 ms | 48.3 dB     | 33.5 dB      | 0.2 %       | 258 / 313 µs              |
| **Signalsmith 120 ms split** (prototype) | 139–150 ms | 48.3 dB     | 33.6 dB      | 0.2 %       | 53 / 71 µs                |
| Signalsmith 90 ms split                  | 106–113 ms | 47.4 dB     | 25.6 dB      | 0.2 %       | 48 / 57 µs                |
| Signalsmith 60 ms split                  | 71–75 ms   | 43.5 dB     | 16.2 dB      | 0.2 %       | 49 / 57 µs                |

- **Quality.** About 25 dB cleaner on a single tone and 22 dB on a triad. Purity is harmonic energy against everything else, so aliasing, phasiness and splice noise all count against it. Transposing up, SoundTouch's WSOLA repeats transients: a click comes out doubled, 17 % of its energy outside the click (47–60 % at +12). Signalsmith keeps the click whole; its pre-echo starts about 15 ms early at −20 to −30 dB.
- **Latency.** The same ballpark as now at the 120 ms block. Shorter blocks cut it, at a cost in polyphonic purity: frequency resolution suffers, and the triad drops to 16 dB at 60 ms. That is still better than SoundTouch's 11 dB.
- **CPU.** With `splitComputation`, the worst quantum is about 5× lower than SoundTouch's and very even. That flat profile is exactly what Firefox's worklet deadline needs: the Firefox cracks came from spikes, not from the average. The mean is about 1.5× SoundTouch's. In real Chromium (OfflineAudioContext, 20 s, +5 st) it renders 96× faster than real time, against 144× for SoundTouch: about 1 % of a core against 0.7 %.
- **Loudness.** RMS is unchanged. Peaks rise up to about 1.6–2× on a sawtooth, which is the worst case, because phase relationships change. Loud masters may need a few dB of headroom before the destination.

## Integration findings

- **CSP: fine.** The package's default worklet URL is a Blob, which YouTube's `script-src` would refuse. `SignalsmithStretch.moduleUrl` can override it, but the factory isn't needed at all: the worklet file self-registers, and `lib/shifters.ts` loads it from our extension URL. WASM compiles inside the worklet; YouTube's CSP has `'unsafe-eval'`, and Chromium ran it.
- **Tempo:** in live-input mode `rate` is ignored, so we keep the current model: the element resamples raw, and the shift is `semitones − 12·log2(tempo)`. Checked in Chromium for both engines (`wrapper.html`, within 0.5 %). Tempo alone stays native.
- **Bug in 1.3.2:** a change in channel count calls a bare `configure()` (`ReferenceError`). Avoided by pinning the node to explicit stereo.
- **Inactive means silent:** the processor outputs zeros when `active` is false, so the engine starts it only while routed through.
- **Bundle:** `injected.js` stays at 11 KB, and the worklet adds a 114 KB web-accessible file.
- **The quality knobs** (`overlapMs`, `quickSeek`) are SoundTouch-only. Signalsmith's equivalents are block and interval (and `tonalityHz`, formant options).

## Not verified (needs you)

1. **By ear on YouTube, both browsers.** Load the build, open a song, and flip Options → Engine while it plays. Listen for transients, vocals, bass, ±12 st, and pitch + tempo together.
2. **Firefox at all.** Nothing here ran in Firefox. Watch for the WASM instantiating in Firefox's AudioWorkletGlobalScope (it lacks some globals; the module polyfills `atob`), render-deadline cracks, and the engine switch.
3. **AMO review.** We would ship a WASM binary inside minified emscripten output. Mozilla requires source for generated code. The Signalsmith source is public (MIT) with a build, but reviewers may ask for reproducible build steps. Expect friction in review.
4. **Lip sync** in practice at the 120 ms block, versus 90 ms.

## Recommendation

Switch, if the ear test agrees. The offline gap is large and on the right axes (purity, transients, even CPU), and integration has no blocker. For production:

- Drop SoundTouch, `PacedPipe`, `OutputCushion`, the band-limited kernel and the WSOLA knobs, and the engine toggle with them.
- Choose the block size by ear: 120 ms split for music purity, or 90 ms split for about 35 ms less latency.
- Add an options knob for that block size if listeners split.
- Add headroom.
- Settle the AMO source question before release.
