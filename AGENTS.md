# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What this is

Modulate is a browser extension (WXT + Preact) that transposes YouTube video audio by semitones (±12) **and** time-stretches playback speed (0.5×–2×, pitch held constant), per video. State persists in `chrome.storage.local` keyed by YouTube video ID. UI is a popup (live controls) plus an options page (audio-quality knobs + saved-video management). Keyboard `commands` and a toolbar badge are driven by the background script. See `ROADMAP.md` for planned work (in-player controls, `sync` storage).

## Commands

Package manager is **bun** (`bun.lock`).

- `bun run dev` — dev server, Chrome (MV3) at `.output/chrome-mv3-dev`
- `bun run dev:firefox` — dev server, Firefox (MV2)
- `bun run build` / `bun run build:firefox` — production build
- `bun run zip` / `bun run zip:firefox` — packaged extension for store upload
- `bun run compile` — `tsc --noEmit` type check (the only check; there are no tests or linter)
- `postinstall` runs `wxt prepare` (regenerates `.wxt/` types); run it manually if imports/types look stale

There is no test suite. Verify changes by loading the unpacked build and exercising the popup (and the options page) on a YouTube watch page.

## Architecture: three realms, two message hops

The core constraint driving the whole design: the Web Audio graph **must run in the page's MAIN world**, not the content-script sandbox. Firefox throws `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created object into the page-realm worklet. So responsibilities are split across three realms (popup→content and content→injected are the two hops; the background script is a side actor for shortcuts + badge):

```
popup (Preact) --PopupMessage-->  content script  --ApplyMessage (JSON string)-->  injected (MAIN world)
                browser.tabs       |   ^                window.postMessage
                .sendMessage       |   | PopupMessage (keyboard commands) /
                                   |   | BadgeMessage (effective state)
                                   v   |
                              background (commands + toolbar badge)
```

- **`entrypoints/popup/`** — React UI. A thin remote: sends `PopupMessage` to the active tab's content script and renders the returned `PlayerState` (pitch + tempo steppers/sliders, global + per-video toggles, reset). Owns no logic. Renders an empty state when the tab has no content script (not YouTube). Has a button to open the options page.
- **`entrypoints/options/`** — React UI. Edits storage **directly** (not via messages): the global switch, the shared `audioQuality` WSOLA knobs, and the list of saved per-video settings (remove one / clear all). Content scripts re-apply live via `storage.watch`.
- **`entrypoints/content.ts`** — runs on `*://*.youtube.com/*`. **Owns storage.** Injects `injected.js` into the page via a `<script src=…>` tag (not inline — YouTube CSP blocks inline). Resolves effective pitch/tempo/quality from storage + toggles (`resolveSetting`), forwards them to the main world, and posts a `BadgeMessage` to the background. Re-applies on SPA nav (`yt-navigate-finish` event + a 1s URL-poll fallback) and on `storage.watch`. Resolves `processorUrl` here via `browser.runtime.getURL` because the main world has no extension APIs.
- **`entrypoints/injected.ts`** — runs in MAIN world. Owns the Web Audio graph (`lib/audioEngine.ts`). Listens for `window.postMessage`, finds the `<video>` (with a `MutationObserver` since it mounts late), builds the graph, applies pitch + tempo. Defers the first graph build until the page has user activation (see invariants below).
- **`entrypoints/background.ts`** — drives keyboard `commands` (forwards `NUDGE_*` `PopupMessage`s to the active tab) and renders the per-tab toolbar badge from `BadgeMessage`s sent by content scripts.

### Message protocol (`lib/messaging.ts`)

`PopupMessage` (popup/background→content): `GET_STATE | SET_SEMITONES | NUDGE_SEMITONES | SET_TEMPO | NUDGE_TEMPO | SET_VIDEO_ENABLED | SET_GLOBAL_ENABLED | RESET`. Content always replies with a fresh `PlayerState` (`videoId`, `globalEnabled`, `enabled`, `semitones`, `tempo`).

`BadgeMessage` (content→background): the effective `semitones` + `tempo` for the sending tab; the background renders/clears its badge text.

`ApplyMessage` (content→injected) crosses the content/page membrane, so it is **posted as a JSON string** — a raw object arrives as `null` in the page realm without `cloneInto`. Carries the resolved `semitones`, `tempo`, the `processorUrl`, and the WSOLA quality fields. Always `JSON.stringify` on send and `JSON.parse` + validate `source === 'modulate'` on receive.

`GET_STATE` is a pure read fired on popup mount and **must never touch the audio graph** — otherwise the popup response blocks on graph build / context resume. Only mutating messages call `apply()` (fire-and-forget).

## Audio engine invariants (`lib/audioEngine.ts`)

These are load-bearing; violating them mutes audio or throws:

- `createMediaElementSource` may be called **only once** per element. After it runs, the element no longer outputs to speakers directly — all audio flows through the graph. So "off" = bypass the worklet (route source straight to destination, set `pitchSemitones`/`playbackRate` to no-op), **never disconnect** (disconnecting mutes the video).
- The same YouTube `<video>` persists across SPA navigations, so one graph built once serves every video; only the pitch/tempo parameters change. `ensureGraph` is idempotent (it does rebuild if YouTube swaps the element — ads/miniplayer — disposing the old context to avoid leaking past the browser's ~6-context cap).
- Tempo is applied by setting the **element's** `playbackRate` (which lowers pitch like a record) and mirroring it to the SoundTouch `playbackRate` param so the worklet compensates pitch back. This requires `preservesPitch = false` on the element, or the compensation double-corrects.
- `AudioContext` starts `suspended`; `resume()` needs user activation. So `injected.ts` defers the **first** graph build until `navigator.userActivation.hasBeenActive` (or a popup click) — building under a suspended context would capture the element and play it silently. Auto-applies (page load, SPA nav, options edits) carry no gesture, so they queue and retry on the first `pointerdown`/`keydown`.

## Storage (`lib/storage.ts`)

WXT storage items: `local:globalEnabled` (master switch), `local:videoSettings` (a single `Record<videoId, VideoSetting>` object, where `VideoSetting` is `{ enabled, semitones, tempo }`), and `local:audioQuality` (shared WSOLA knobs). `resolveSetting(global, video)` is the single source of truth for what gets applied: the no-op (`{ semitones: 0, tempo: 1 }`) when the global switch is off, no per-video entry exists, or that entry is disabled; otherwise the entry's values. Clamp ranges: `MIN/MAX_SEMITONES` (±12) and `MIN/MAX_TEMPO` (0.5×–2×, snapped to `TEMPO_STEP`). Note: `videoSettings` grows unbounded — there is no pruning yet (see ROADMAP).

## `public/soundtouch-processor.js` — do not hand-edit

This is the bundled `@soundtouchjs/audio-worklet` AudioWorklet processor (SoundTouch WSOLA time-stretch + Lanczos-interpolated rate transpose). It is a generated artifact loaded as a web-accessible resource. Replace it by updating the dependency, not by editing it. New web-accessible resources for the page must be registered in `wxt.config.ts` under `web_accessible_resources`.
