# Modulate — Roadmap

MVP shipped: per-video pitch transpose (±12 semitones), global + per-video toggles,
`chrome.storage.local` persistence keyed by YouTube video ID, popup-only UI.

The audio engine (`lib/audioEngine.ts`) already routes the player through
`@soundtouchjs/audio-worklet`'s `SoundTouchNode`, which exposes more than pitch. The items
below are scoped against that existing graph.

## Near term

- **Tempo / speed control.** `SoundTouchNode` has `playbackRate` and `pitch` AudioParams.
  Independent time-stretch (slow down without dropping pitch) just needs UI + a
  `SET_TEMPO` message and a `tempo` field added to `VideoSetting`. Mirror the source's
  `playbackRate` to `stNode.playbackRate.value` so pitch is compensated (see SoundTouchJS
  docs). Keep transpose and tempo independent.
- **In-player controls.** Add a shadow-root UI (`createShadowRootUi`) mounted in the
  YouTube player bar for always-visible +/− buttons. Must mount/unmount across SPA
  navigation; reuse the same content-script `apply()` path.
- **Visual active indicator.** Badge on the toolbar icon when a tab is actively transposed.

## Later

- **Presets / quick keys.** Keyboard shortcuts (e.g. `[` / `]`) via `commands` manifest
  key; saved preset offsets.
- **Per-channel defaults.** Optional default transpose for a whole channel.
- **`sync` storage option.** Move settings to `chrome.storage.sync` for cross-device use.
  Watch the quota: sync caps ~100KB and ~512 items, so prune old video entries or store a
  compact form before switching.
- **Settings management.** A page to list/clear saved per-video settings (the
  `local:videoSettings` map grows unbounded today).
- **Quality tuning.** Expose `setStretchParameters` / interpolation strategy for users who
  want to trade latency vs. artifacts at extreme shifts.
