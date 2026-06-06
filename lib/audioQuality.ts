/**
 * WSOLA time-stretch tuning, applied to the SoundTouch worklet.
 *
 * Only the safe knobs are exposed. The window-length params (`sequenceMs` /
 * `seekWindowMs`) are intentionally left to the worklet's tempo-adaptive
 * auto-calculation: a small manual `sequenceMs` makes the WSOLA `nominalSkip`
 * round to 0, which spins `Stretch.process()` in an infinite loop (drains 0
 * frames per window) and freezes the audio thread — the player then hangs on an
 * endless spinner. Auto-calc is well-tuned and avoids that entirely.
 *
 * Kept in a side-effect-free module (no `storage.defineItem`, no extension APIs)
 * so the MAIN-world injected bundle can import the defaults without pulling
 * `storage.ts` — which touches extension APIs unavailable in the page realm.
 */
export interface AudioQuality {
	overlapMs: number
	quickSeek: boolean
}

/** Defaults mirror the values the audio engine used to hardcode. */
export const DEFAULT_AUDIO_QUALITY: AudioQuality = {
	overlapMs: 12,
	quickSeek: true,
}
