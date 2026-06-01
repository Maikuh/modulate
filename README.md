# Modulate

A browser extension that **transposes YouTube video audio by semitones (±12)** and
**time-stretches playback speed (0.5×–2×) while holding pitch constant** — independently,
per video. Settings persist per YouTube video ID, so each video remembers its own pitch
and tempo.

Built with [WXT](https://wxt.dev) + [Preact](https://preactjs.com), using
[`@soundtouchjs/audio-worklet`](https://github.com/cutterbl/SoundTouchJS) (SoundTouch
WSOLA time-stretch + Lanczos-interpolated rate transpose) for the audio processing.

## Features

- **Pitch transpose** — shift audio ±12 semitones without changing speed.
- **Tempo / speed** — 0.5×–2× playback with pitch held constant (no chipmunk effect).
- **Per-video state** — each YouTube video keeps its own settings, keyed by video ID.
- **Global + per-video toggles** — a master switch plus an on/off per video.
- **Keyboard shortcuts** — nudge pitch/tempo without opening the popup:
  - `Ctrl+Shift+Up` / `Ctrl+Shift+Down` — pitch up / down a semitone
  - `Ctrl+Shift+Right` / `Ctrl+Shift+Left` — tempo up / down
- **Toolbar badge** — shows when an effect is active on the current tab.
- **Audio-quality tuning** — WSOLA knobs exposed on the options page.
- **Saved-video management** — review, remove, or clear stored per-video settings.

## Install (development)

Package manager is **[bun](https://bun.sh)**.

```sh
bun install
bun run dev          # Chrome (MV3), dev server at .output/chrome-mv3-dev
bun run dev:firefox  # Firefox (MV2)
```

`bun run dev` launches a browser with the unpacked extension loaded. Open a YouTube
watch page and click the toolbar icon for the popup controls.

## Build

```sh
bun run build          # production build, Chrome (MV3)
bun run build:firefox  # Firefox (MV2)
bun run zip            # packaged .zip for store upload (Chrome)
bun run zip:firefox    # packaged .zip for store upload (Firefox)
```

## Develop

```sh
bun run compile       # tsc --noEmit type check
bun run lint          # oxlint
bun run lint:fix      # oxlint --fix
bun run format        # oxfmt
bun run format:check  # oxfmt --check
bun run test          # vitest (happy-dom)
bun run test:watch    # vitest watch mode
```

Tests cover unit logic and Testing Library component specs. They do **not** exercise the
live audio graph or the cross-realm message flow — verify those by loading the unpacked
build and exercising the popup and options page on a real YouTube watch page.

## How it works

The Web Audio graph must run in the page's **MAIN world**, not the content-script
sandbox (Firefox throws `DataCloneError` when an `AudioWorkletNode` serializes a
sandbox-created object into the page-realm worklet). So responsibilities split across
three realms with two message hops:

```
popup (Preact) --PopupMessage-->  content script  --ApplyMessage (JSON)-->  injected (MAIN world)
                browser.tabs       |   ^                window.postMessage
                .sendMessage       |   | PopupMessage (keyboard commands) /
                                   |   | BadgeMessage (effective state)
                                   v   |
                              background (commands + toolbar badge)
```

- **`entrypoints/popup/`** — Preact UI. A thin remote: sends messages to the active
  tab's content script and renders the returned player state. Owns no logic.
- **`entrypoints/options/`** — Preact UI. Edits storage directly: global switch, shared
  WSOLA quality knobs, saved per-video settings. Content scripts re-apply live via
  `storage.watch`.
- **`entrypoints/content.ts`** — runs on YouTube. Owns storage. Injects `injected.js`
  into the page, resolves the effective pitch/tempo/quality, forwards them to the main
  world, and re-applies on SPA navigation.
- **`entrypoints/injected.ts`** — runs in MAIN world. Owns the Web Audio graph
  (`lib/audioEngine.ts`); finds the `<video>`, builds the graph, applies pitch + tempo.
- **`entrypoints/background.ts`** — drives keyboard `commands` and the toolbar badge.

State lives in `chrome.storage.local`: a master switch (`globalEnabled`), a
`Record<videoId, { enabled, semitones, tempo }>` map (`videoSettings`), and shared WSOLA
knobs (`audioQuality`).

See [`AGENTS.md`](AGENTS.md) for the full architecture and invariants, and
[`ROADMAP.md`](ROADMAP.md) for planned work.

## License

[GPL-3.0-only](LICENSE)
