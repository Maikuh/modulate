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
- `bun run compile` — `tsc --noEmit` type check
- `bun run lint` / `bun run lint:fix` — oxlint (`.oxlintrc.json`); whole repo minus `ignorePatterns`, with the typescript + unicorn + oxc + import + react + jsx-a11y plugins (vitest only under the test override)
- `bun run format` / `bun run format:check` — oxfmt (`.oxfmtrc.json`): tabs, no semi, single quote, trailing commas, import sort
- `postinstall` runs `wxt prepare` (regenerates `.wxt/` types); run it manually if imports/types look stale

Tests run via Vitest (`bun run test` / `test:watch`) — happy-dom env (`*.test.ts`/`*.test.tsx`): unit specs for `lib/`, Testing Library specs for the popup and options pages, entrypoint specs for the content, injected and background scripts (each realm on its own, messages driven by hand), and an audio-engine spec against a hand-rolled fake Web Audio graph. None of them run a real audio graph or the real three-realm message flow, so also verify changes by loading the unpacked build and exercising the popup (and the options page) on a YouTube watch page.

## Architecture: three realms, two message hops

The core constraint driving the whole design: the Web Audio graph **must run in the page's MAIN world**, not the content-script sandbox. Firefox throws `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created object into the page-realm worklet. So responsibilities are split across three realms (popup→content and content⇄injected are the two hops; the background script is a side actor for shortcuts + badge):

```
popup (Preact) --PopupMessage-->  content script  --ApplyMessage (JSON string)-->   injected (MAIN world)
                browser.tabs       |   ^          <--StatusMessage (JSON string)--
                .sendMessage       |   |                 window.postMessage
                                   |   | PopupMessage (keyboard commands) /
                                   |   | BadgeMessage (effective state + status)
                                   v   |
                              background (commands + toolbar badge)
```

- **`entrypoints/popup/`** — Preact UI. A thin remote: sends `PopupMessage` to the active tab's content script and renders the returned `PlayerState` (pitch + tempo steppers/sliders, global + per-video toggles, reset). Owns no logic. Renders an empty state when the tab has no content script (not YouTube, or a YouTube tab opened before an install/update — then it asks for a reload when the tab URL is readable) or is not on a watch page. Shows the page engine's `AudioStatus` when it isn't simply playing (waiting for a click in the page, no player, failure), and a failed write as an error rather than a state. Has a button to open the options page.
- **`entrypoints/options/`** — Preact UI. Edits storage **directly** (not via messages): the global switch, the shared `audioQuality` WSOLA knobs, and the list of saved per-video settings (remove one / clear all). Content scripts re-apply live via `storage.watch`, and the page itself watches the same three keys so it stays in sync with edits made from the popup.
- **`entrypoints/content.ts`** — runs on `*://*.youtube.com/*`. **Owns storage.** Injects `injected.js` into the page via a `<script src=…>` tag (not inline — YouTube CSP blocks inline). Resolves effective pitch/tempo/quality from storage + toggles (`resolveSetting`), forwards them to the main world, and posts a `BadgeMessage` to the background (again whenever the page engine reports a new `AudioStatus`). Re-applies on SPA nav (`yt-navigate-finish` event + a 1s URL-poll fallback) and on `storage.watch`. Every storage mutation runs through one `serialize()` chain — per-video writes are read-modify-write of a single record, so concurrent handlers lose updates. On context invalidation (extension disabled/updated/uninstalled) it posts a no-op, because the page-realm engine outlives it. Resolves `processorUrl` here via `browser.runtime.getURL` because the main world has no extension APIs.
- **`entrypoints/injected.ts`** — runs in MAIN world. Owns the Web Audio graph (`lib/audioEngine.ts`). Listens for `window.postMessage`, finds the `<video>` (with a `MutationObserver` since it mounts late), builds the graph, applies pitch + tempo, and posts a `StatusMessage` back after each apply settles. Behaviors worth knowing before editing it: **the latest message always wins** — every trigger (new message, media-event replay, first-gesture retry) only marks the latest `ApplyMessage` dirty for a single worker, and `apply()` bails after each await when a newer one arrived, so a reset can never be overtaken by an older change still waiting on a gesture, the `<video>` or the build; it **lazily captures** (a no-op message never builds a graph, and a no-op with a graph bypasses in place without re-resolving the element); it **replays** on the element's `loadstart`/`emptied`/`ratechange`, rebinding those listeners when YouTube swaps the `<video>`, because the nav event fires before the media is ready; a **second copy stands down** (Firefox re-injects content scripts on update, and only the first instance can own the captured element); and it disposes the context on `pagehide` **only when not entering bfcache** (see invariants below).
- **`entrypoints/background.ts`** — drives keyboard `commands` (forwards `NUDGE_*` `PopupMessage`s to the active tab) and renders the per-tab toolbar badge **and icon** from `BadgeMessage`s sent by content scripts (muted tint while the page waits for a click, `!` on an engine failure): colored icon on a watchable video, grayscale otherwise (the grayscale set is generated by `modules/generate-disabled-icons.ts` and is the manifest's `default_icon`). It also resets the icon on full-document navigation, since a per-tab override would otherwise strand the colored icon after leaving YouTube.

### Message protocol (`lib/messaging.ts`)

`lib/messaging.ts` is imported by the MAIN-world bundle, so it must stay free of extension APIs (it pulls only the side-effect-free `lib/settings.ts` and `lib/audioQuality.ts`).

`PopupMessage` (popup/background→content): `GET_STATE | SET_SEMITONES | NUDGE_SEMITONES | SET_TEMPO | NUDGE_TEMPO | SET_VIDEO_ENABLED | SET_GLOBAL_ENABLED | RESET`. Content always replies — with a `PopupResponse`: `{ ok: true, state: PlayerState }` (`videoId`, `globalEnabled`, `enabled`, `semitones`, `tempo`, `audio`) or `{ ok: false, error }`. A failure is never answered with a default-valued state, which would read as a reset.

`BadgeMessage` (content→background): the effective `semitones` + `tempo` for the sending tab, `onVideo` (whether the tab is on a watchable video), and the engine's `status`. The background renders/clears the badge text — pitch as a bare number, tempo-only as `♪`, `!` on an engine error — tints it by status, and picks the colored or grayscale icon from `onVideo`.

`ApplyMessage` (content→injected) crosses the content/page membrane, so it is **posted as a JSON string** — a raw object arrives as `null` in the page realm without `cloneInto`. Carries the resolved `semitones`, `tempo`, the `processorUrl`, and the WSOLA quality fields. Always `JSON.stringify` on send. On receive, `parseApplyMessage` validates **every** field, not just the discriminant, and clamps the numbers onto the storage ranges: the MAIN world is shared with YouTube's own scripts and any other extension injecting there, `processorUrl` goes straight to `audioWorklet.addModule` (so it must be a `chrome-extension://`/`moz-extension://` URL), and an out-of-range number reaches restricted-float writes that throw. A payload carrying our marker that fails validation logs a warning.

`StatusMessage` (injected→content, JSON string too): the `AudioStatus` of the latest apply — `idle | applied | waiting-for-gesture | no-video | error`. Anything in the MAIN world can forge one, which is acceptable because it only changes what the popup and badge say.

Routine "nobody is listening" messaging failures go through `logSendFailure` (debug level); anything else warns.

`GET_STATE` is a pure read fired on popup mount and **must never touch the audio graph** — otherwise the popup response blocks on graph build / context resume. Only mutating messages call `apply()` (fire-and-forget).

## Audio engine invariants (`lib/audioEngine.ts`)

These are load-bearing; violating them mutes audio or throws:

- `createMediaElementSource` may be called **only once per element, for the document's lifetime** — not once per context. A second call throws `InvalidStateError` even from a fresh context, and closing the old context does not release the element (closing makes its output _ignored_, it does not restore direct output). After it runs, the element no longer outputs to speakers directly — all audio flows through the graph. So "off" = bypass the worklet (route source straight to `destination`, restore native element rate), and the real rule is that **every path through `route()` must end with the source reaching `destination`** — leaving it disconnected mutes the video with no recovery short of a reload.
- The same YouTube `<video>` persists across SPA navigations, so one graph built once serves every video; only the pitch/tempo parameters change. `ensureGraph` is idempotent and safe to await concurrently — including for _different_ elements, where it waits out the in-flight build rather than handing back a promise that would resolve against the wrong `<video>`. It rebuilds when YouTube swaps the element (ads/miniplayer), disposing the old context to avoid leaking past the browser's cap on live contexts. `build()` adopts its context **before** any step that can throw, so a failed build can still be closed — but **never disposes once `createMediaElementSource` has succeeded**: from then on the element outputs only through that context, and closing it would mute the video for good. An element whose context was already disposed is refused up front (it can't be captured again).
- `route()` falls back to the bypass wiring on a throw and records the no-op to match it. A worklet `processorerror` also routes around the worklet, and the graph stays bypassed until a new element gets a fresh one.
- Tempo is applied by setting the **element's** `playbackRate` (which lowers pitch like a record) and mirroring it to the SoundTouch `playbackRate` param so the worklet compensates pitch back. This requires `preservesPitch = false` on the element, or the compensation double-corrects. **Only when tempo ≠ 1**: at tempo 1 the worklet compensates nothing, so the engine hands the rate back to the page (`preservesPitch = true`, and it resets `playbackRate` only if it was the one driving it). Otherwise a pitch-only setting would make YouTube's own speed menu resample raw and shift pitch uncorrected.
- `AudioContext` starts `suspended` without activation; `resume()` needs user activation. So `injected.ts` defers the **first** graph build until `navigator.userActivation.hasBeenActive` — building under a suspended context would capture the element and play it silently. This gates **every** trigger, popup clicks included: `hasBeenActive` is a property of the page's window, and the popup is a separate `chrome-extension://` browsing context that grants the YouTube document nothing. So all applies queue and retry on the first `pointerdown`/`keydown` in the page itself. `resume()` is bounded by a timeout: on a context that isn't allowed to start it stays pending (per spec), and an unbounded await would stall the apply worker.

## Storage (`lib/storage.ts`) and setting rules (`lib/settings.ts`)

WXT storage items: `local:globalEnabled` (master switch), `local:videoSettings` (a single `Record<videoId, VideoSetting>` object, where `VideoSetting` is `{ enabled, semitones, tempo, title? }`), and `local:audioQuality` (shared WSOLA knobs). Only `globalEnabled` is exported raw; the other two are private behind accessors (`getRawVideoSetting`/`setVideoSetting`/…, `getAudioQuality`/`setAudioQuality`).

The value rules live in `lib/settings.ts`, side-effect-free so every realm can import them: ranges, clamps, `DEFAULT_VIDEO_SETTING`, `NO_OP`, `isNoOp` (the single no-op check — storage pruning, engine bypass, lazy capture and the badge all call it) and `resolveSetting(global, video)`, the single source of truth for what gets applied: the no-op (`{ semitones: 0, tempo: 1 }`) when the global switch is off, no per-video entry exists, or that entry is disabled; otherwise the entry's values.

Ranges are enforced by `normalize()` (video settings) and `normalizeQuality()` (`lib/audioQuality.ts`) on **every read and every write** — never at call sites. `normalize()` builds entries field by field, so unknown keys and a non-string `title` are dropped. `defineItem`'s type parameter is an unchecked assertion (its `fallback` only fires when the key is absent), so a value written by an older version or edited from devtools arrives typed as a `VideoSetting` without having been one, and an out-of-range `tempo` reaches `element.playbackRate`: `0` freezes the video, `NaN` throws mid-reroute and mutes it. A quality value missing a field is worse still: `JSON.stringify` drops the key from the `ApplyMessage`, and the page-side parser then rejects every apply. Clamp ranges: `MIN/MAX_SEMITONES` (±12), `MIN/MAX_TEMPO` (0.5×–2×, snapped to `TEMPO_STEP`), and `MIN/MAX_OVERLAP_MS` in `lib/audioQuality.ts` (floor 1 — SoundTouch silently ignores `overlapMs` of 0). Writes prune: an **enabled** entry sitting at the no-op is deleted rather than stored, because `resolveSetting` cannot tell it from having no entry, while `videoSettings` is a single object rewritten in full on every write — so dead keys cost latency on every later nudge. This makes `RESET` self-cleaning. A **disabled** entry is kept even at the no-op: "off for this video" is a real choice that has to survive to be listed and toggled back on. Growth is therefore bounded by videos actually tuned, not by videos visited.

## `soundtouch-processor.js` — copied from the dependency at build

The AudioWorklet processor (SoundTouch WSOLA time-stretch + Lanczos-interpolated rate transpose) is **not** committed. `modules/copy-soundtouch-processor.ts` (a WXT module) copies it from `@soundtouchjs/audio-worklet/processor` into the build output as `soundtouch-processor.js` via the `build:publicAssets` hook, and registers the path with `prepare:publicPaths` so `browser.runtime.getURL('/soundtouch-processor.js')` stays typed. Upgrade it by bumping the dependency — never hand-edit the generated processor.

Why a build copy and not a Vite `?url` import: WXT inlines `?url` assets as a `data:` URI, and the worklet loads in YouTube's MAIN world where the page CSP would govern (and can block) a `data:` module. A `chrome-extension://` web-accessible file sidesteps that. New web-accessible resources for the page must be registered in `wxt.config.ts` under `web_accessible_resources`.
