# Modulate — Roadmap

Shipped: per-video pitch transpose (±12 semitones) **and** independent tempo / speed
control, global + per-video toggles, keyboard shortcuts (Chrome `commands`), a toolbar
badge active-indicator, WSOLA quality tuning, and a settings page to manage saved
per-video entries. State persists in `chrome.storage.local` keyed by YouTube video ID.
UI is popup + options page.

The audio engine (`lib/audioEngine.ts`) routes the player through
`@soundtouchjs/audio-worklet`'s `SoundTouchNode` (pitch + tempo + stretch params).

## Near term

- **In-player controls.** Add a shadow-root UI (`createShadowRootUi`) mounted in the
  YouTube player bar for always-visible +/− buttons. Must mount/unmount across SPA
  navigation; reuse the same content-script `apply()` path.

## Later

- **`sync` storage option.** Move settings to `chrome.storage.sync` for cross-device use.
  Watch the quota: sync caps ~100KB and ~512 items. Writes now prune entries that sit
  at the no-op, so the per-video map (`local:videoSettings`) tracks videos actually
  tuned rather than videos visited — but it is still one object with no hard cap, so
  sync only the global switch, or compact the map first.
- **Interpolation strategy tuning.** The quality page exposes WSOLA stretch params today;
  swapping the rate-transposer interpolation strategy additionally needs a second
  web-accessible worklet module (`registerStrategyModule`) — left out to avoid bundling.
