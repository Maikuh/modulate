/**
 * Pitch/tempo value rules shared by every realm.
 *
 * Kept side-effect-free (no `storage.defineItem`, no extension APIs) so the
 * MAIN-world injected bundle can import it without pulling `storage.ts`, which
 * touches extension APIs unavailable in the page realm. Everything that decides
 * what a value means — ranges, clamps, "is this the no-op" — lives here so the
 * storage boundary, the message parser, the audio engine and the badge cannot
 * drift apart.
 */

/** Persisted transpose settings for a single video. */
export interface VideoSetting {
	/** Per-video enable toggle. */
	enabled: boolean
	/** Pitch shift in semitones. */
	semitones: number
	/** Playback rate (1 = original speed); pitch is held constant. */
	tempo: number
	/**
	 * Human-readable video title, captured from the watch page at save time so
	 * the options list is readable. Optional: legacy entries (and any saved
	 * before the title resolved) fall back to the video ID.
	 */
	title?: string
}

export const DEFAULT_VIDEO_SETTING: Readonly<VideoSetting> = Object.freeze({
	enabled: true,
	semitones: 0,
	tempo: 1,
})

/** Range clamp for the semitone stepper (±12 = one octave). */
export const MIN_SEMITONES = -12
export const MAX_SEMITONES = 12

/** Range clamp for the tempo stepper. */
export const MIN_TEMPO = 0.5
export const MAX_TEMPO = 2
export const TEMPO_STEP = 0.05

/**
 * Clamp helpers — keep the same rounding everywhere a value is persisted.
 *
 * The `Number.isFinite` guards are load-bearing, not defensive noise: `NaN`
 * survives both `Math.round` and `Math.min`/`Math.max` unchanged, so without them
 * a `NaN` reaches `element.playbackRate` and `AudioParam.value`, which are
 * restricted floats and throw `TypeError`. That throw lands mid-reroute in
 * `AudioEngine.route()`, between the disconnect and the reconnect. They also
 * reject non-numbers outright, which is what a hand-edited or version-skewed
 * storage entry looks like.
 */
export function clampSemitones(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_VIDEO_SETTING.semitones
	return Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, Math.round(n)))
}

export function clampTempo(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_VIDEO_SETTING.tempo
	// Round to the step grid so float drift from repeated nudges can't accumulate.
	const snapped = Math.round(n / TEMPO_STEP) * TEMPO_STEP
	return Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, Number(snapped.toFixed(2))))
}

/** Resolved values actually applied to audio after layering all the toggles. */
export interface ResolvedSetting {
	semitones: number
	tempo: number
}

/**
 * "Leave the audio alone": no transpose, original speed. Frozen because it is
 * handed straight back to callers, and one stray mutation would silently retune
 * every untouched video.
 */
export const NO_OP: Readonly<ResolvedSetting> = Object.freeze({ semitones: 0, tempo: 1 })

/**
 * Whether a setting asks for nothing. The single definition behind whether an
 * entry is worth storing, whether the audio graph bypasses its worklet (and
 * whether a first capture is warranted at all), and whether the toolbar shows a
 * badge.
 */
export function isNoOp(setting: ResolvedSetting): boolean {
	return setting.semitones === NO_OP.semitones && setting.tempo === NO_OP.tempo
}

/**
 * Resolve the values actually applied to audio. An explicit per-video setting
 * applies; otherwise the no-op (0 / 1×). The global master switch and the
 * per-video `enabled` toggle gate everything — when either is off the result is
 * the no-op so the video plays untransposed.
 */
export function resolveSetting(global: boolean, video: VideoSetting | undefined): ResolvedSetting {
	if (!global || !video?.enabled) return { ...NO_OP }
	return { semitones: video.semitones, tempo: video.tempo }
}
