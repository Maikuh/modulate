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

export const DEFAULT_AUDIO_QUALITY: Readonly<AudioQuality> = Object.freeze({
	overlapMs: 12,
	quickSeek: true,
})

/**
 * Range for the overlap slider. The floor is 1, not 0: SoundTouch guards
 * `overlapMs > 0` and silently keeps its previous value otherwise, so a stored 0
 * would render in the options page as an applied setting the DSP never took.
 */
export const MIN_OVERLAP_MS = 1
export const MAX_OVERLAP_MS = 40

export function clampOverlapMs(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_AUDIO_QUALITY.overlapMs
	return Math.max(MIN_OVERLAP_MS, Math.min(MAX_OVERLAP_MS, Math.round(n)))
}

/**
 * Force a stored quality value onto the valid ranges, the way `normalize` does for
 * video settings — and for the same reason: the storage item's type is an
 * unchecked assertion, so an older version's write (the overlap slider once went
 * down to 0) or a devtools edit arrives typed as `AudioQuality` without being one.
 * A missing field is worse than an out-of-range one here: `JSON.stringify` drops
 * it from the `ApplyMessage`, and the page-side parser then rejects every apply.
 */
export function normalizeQuality(raw: unknown): AudioQuality {
	const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
		Record<keyof AudioQuality, unknown>
	>
	return {
		overlapMs: clampOverlapMs(typeof q.overlapMs === 'number' ? q.overlapMs : Number.NaN),
		quickSeek: q.quickSeek !== false,
	}
}
