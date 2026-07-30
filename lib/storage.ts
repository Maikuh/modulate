import { storage } from 'wxt/utils/storage'

import { DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@/lib/audioQuality'

// Re-export so existing `@/lib/storage` consumers keep working.
export { DEFAULT_AUDIO_QUALITY, type AudioQuality }

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

export const DEFAULT_VIDEO_SETTING: VideoSetting = {
	enabled: true,
	semitones: 0,
	tempo: 1,
}

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
 * `AudioEngine.route()`, between the disconnect and the reconnect, leaving the
 * video permanently muted. They also reject non-numbers outright, which is what
 * a hand-edited or version-skewed storage entry looks like.
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

/**
 * Force a stored entry onto the valid ranges. Applied on every read AND every
 * write, because `storage.defineItem`'s type parameter is an unchecked assertion:
 * its `fallback` only fires when the key is absent, so anything actually sitting
 * in `chrome.storage.local` — written by an older version, edited from devtools,
 * or (on the ROADMAP) synced from another device — arrives typed as a
 * `VideoSetting` without ever having been one.
 */
function normalize(setting: VideoSetting): VideoSetting {
	return {
		...setting,
		enabled: setting.enabled !== false,
		semitones: clampSemitones(setting.semitones),
		tempo: clampTempo(setting.tempo),
	}
}

/** Global master switch. When off, every video plays untransposed. */
export const globalEnabled = storage.defineItem<boolean>('local:globalEnabled', {
	fallback: true,
})

/** Map of videoId → settings. A single object keeps listing/migration simple. */
const videoSettings = storage.defineItem<Record<string, VideoSetting>>('local:videoSettings', {
	fallback: {},
})

/** WSOLA quality knobs, shared across all videos. */
export const audioQuality = storage.defineItem<AudioQuality>('local:audioQuality', {
	fallback: DEFAULT_AUDIO_QUALITY,
})

/** Whether an explicit per-video entry exists (distinct from the merged default). */
export async function getRawVideoSetting(videoId: string): Promise<VideoSetting | undefined> {
	const all = await videoSettings.getValue()
	return all[videoId] ? normalize({ ...DEFAULT_VIDEO_SETTING, ...all[videoId] }) : undefined
}

export async function setVideoSetting(
	videoId: string,
	partial: Partial<VideoSetting>,
): Promise<VideoSetting> {
	const all = await videoSettings.getValue()
	// Drop `undefined` fields so a partial can't blank out a stored value (e.g. a
	// null title before the watch metadata mounts must not erase a saved one).
	const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined))
	// Clamp here rather than at each call site: this is the only way a value enters
	// storage, so enforcing the range at the mutator means callers can't forget.
	const next: VideoSetting = normalize({
		...DEFAULT_VIDEO_SETTING,
		...all[videoId],
		...defined,
	})

	// Prune rather than store an enabled entry sitting at the no-op: `resolveSetting`
	// cannot tell it apart from having no entry at all, so it holds no information
	// the user could lose — while `videoSettings` is one object rewritten in full on
	// every write, so dead keys cost latency on every later nudge. This also makes
	// RESET self-cleaning and keeps the options list to videos actually tuned.
	//
	// A DISABLED entry is kept even at the no-op: "off for this video" is a choice
	// the user made, and it has to survive to be shown and toggled back on.
	if (next.enabled && isNoOp(next)) {
		if (!(videoId in all)) return next
		const { [videoId]: _pruned, ...rest } = all
		await videoSettings.setValue(rest)
		return next
	}

	await videoSettings.setValue({ ...all, [videoId]: next })
	return next
}

export async function listVideoSettings(): Promise<Record<string, VideoSetting>> {
	const all = await videoSettings.getValue()
	// Merge + normalize like the single-entry accessors. Without this the options
	// page reads entries raw, and one missing field (a legacy write, a downgrade)
	// makes `s.tempo.toFixed(2)` throw during render — blanking the whole page,
	// including the controls that would delete the offending entry.
	return Object.fromEntries(
		Object.entries(all).map(([id, s]) => [id, normalize({ ...DEFAULT_VIDEO_SETTING, ...s })]),
	)
}

export async function removeVideoSetting(videoId: string): Promise<void> {
	const all = await videoSettings.getValue()
	if (!(videoId in all)) return
	const { [videoId]: _, ...rest } = all
	await videoSettings.setValue(rest)
}

export async function clearVideoSettings(): Promise<void> {
	await videoSettings.setValue({})
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
 * Whether a setting asks for nothing. Load-bearing in several senses that are
 * easy to drift apart when spelled out inline: it decides whether an entry is
 * worth storing, whether the audio graph bypasses its worklet, and whether the
 * toolbar shows a badge.
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
