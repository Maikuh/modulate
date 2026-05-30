# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What this is

Modulate is a browser extension (WXT + React 19) that transposes YouTube video audio by semitones (±12), per video. State persists in `chrome.storage.local` keyed by YouTube video ID. UI is popup-only today. See `ROADMAP.md` for planned work (tempo control, in-player controls, presets).

## Commands

Package manager is **bun** (`bun.lock`).

- `bun run dev` — dev server, Chrome (MV3) at `.output/chrome-mv3-dev`
- `bun run dev:firefox` — dev server, Firefox (MV2)
- `bun run build` / `bun run build:firefox` — production build
- `bun run zip` / `bun run zip:firefox` — packaged extension for store upload
- `bun run compile` — `tsc --noEmit` type check (the only check; there are no tests or linter)
- `postinstall` runs `wxt prepare` (regenerates `.wxt/` types); run it manually if imports/types look stale

There is no test suite. Verify changes by loading the unpacked build and exercising the popup on a YouTube watch page.

## Architecture: three realms, two message hops

The core constraint driving the whole design: the Web Audio graph **must run in the page's MAIN world**, not the content-script sandbox. Firefox throws `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created object into the page-realm worklet. So responsibilities are split across three realms:

```
popup (React)  --PopupMessage-->  content script  --ApplyMessage (JSON string)-->  injected (MAIN world)
                browser.tabs                          window.postMessage
                .sendMessage
```

- **`entrypoints/popup/`** — React UI. A thin remote: sends `PopupMessage` to the active tab's content script and renders the returned `PlayerState`. Owns no logic. Returns `null` (shows empty state) when the tab has no content script (not YouTube).
- **`entrypoints/content.ts`** — runs on `*://*.youtube.com/*`. **Owns storage.** Injects `injected.js` into the page via a `<script src=…>` tag (not inline — YouTube CSP blocks inline). Resolves effective semitones from storage + toggles, forwards them to the main world. Re-applies on SPA nav (`yt-navigate-finish` event + a 1s URL-poll fallback). Resolves `processorUrl` here via `browser.runtime.getURL` because the main world has no extension APIs.
- **`entrypoints/injected.ts`** — runs in MAIN world. Owns the Web Audio graph (`lib/audioEngine.ts`). Listens for `window.postMessage`, finds the `<video>` (with a `MutationObserver` since it mounts late), builds the graph, applies pitch.
- **`entrypoints/background.ts`** — placeholder stub; unused.

### Message protocol (`lib/messaging.ts`)

`PopupMessage` (popup→content): `GET_STATE | SET_SEMITONES | SET_VIDEO_ENABLED | SET_GLOBAL_ENABLED | RESET`. Content always replies with a fresh `PlayerState`.

`ApplyMessage` (content→injected) crosses the content/page membrane, so it is **posted as a JSON string** — a raw object arrives as `null` in the page realm without `cloneInto`. Always `JSON.stringify` on send and `JSON.parse` + validate `source === 'modulate'` on receive.

`GET_STATE` is a pure read fired on popup mount and **must never touch the audio graph** — otherwise the popup response blocks on graph build / context resume. Only mutating messages call `apply()` (fire-and-forget).

## Audio engine invariants (`lib/audioEngine.ts`)

These are load-bearing; violating them mutes audio or throws:

- `createMediaElementSource` may be called **only once** per element. After it runs, the element no longer outputs to speakers directly — all audio flows through the graph. So "off" = set `pitchSemitones` to 0, **never disconnect** (disconnecting mutes the video).
- The same YouTube `<video>` persists across SPA navigations, so one graph built once serves every video; only the semitone value changes. `ensureGraph` is idempotent.
- `AudioContext` starts `suspended`; `resume()` must be called from a user gesture (the popup click chain provides one).

## Storage (`lib/storage.ts`)

WXT storage items: `local:globalEnabled` (master switch) and `local:videoSettings` (a single `Record<videoId, VideoSetting>` object). `effectiveSemitones(global, setting)` is the single source of truth for what gets applied: `global && setting.enabled ? semitones : 0`. Clamp range is `MIN_SEMITONES`/`MAX_SEMITONES` (±12). Note: `videoSettings` grows unbounded — there is no pruning yet (see ROADMAP).

## `public/soundtouch-processor.js` — do not hand-edit

This is the bundled `@soundtouchjs/audio-worklet` AudioWorklet processor (SoundTouch WSOLA time-stretch + Lanczos-interpolated rate transpose). It is a generated artifact loaded as a web-accessible resource. Replace it by updating the dependency, not by editing it. New web-accessible resources for the page must be registered in `wxt.config.ts` under `web_accessible_resources`.
