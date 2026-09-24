import { storage } from 'wxt/utils/storage'

import { DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@/lib/audioQuality'
import {
	DEFAULT_VIDEO_SETTING,
	clampSemitones,
	clampTempo,
	isNoOp,
	type VideoSetting,
} from '@/lib/settings'

/**
 * Force a stored entry onto the valid ranges. Applied on every read AND every
 * write, because `storage.defineItem`'s type parameter is an unchecked assertion:
 * its `fallback` only fires when the key is absent, so anything actually sitting
 * in `chrome.storage.local` — written by an older version, edited from devtools,
 * or (on the ROADMAP) synced from another device — arrives typed as a
 * `VideoSetting` without ever having been one.
 *
 * Built field by field rather than spread: a spread would carry unknown keys back
 * into storage forever, and an unchecked non-string `title` makes Preact throw
 * while rendering the options list.
 */
function normalize(setting: VideoSetting): VideoSetting {
	const out: VideoSetting = {
		enabled: setting.enabled !== false,
		semitones: clampSemitones(setting.semitones),
		tempo: clampTempo(setting.tempo),
	}
	if (typeof setting.title === 'string') out.title = setting.title
	return out
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

/**
 * The stored entry for `videoId`, merged over the defaults and normalized, or
 * `undefined` when none is stored. `resolveSetting` relies on that distinction:
 * no entry means the no-op, while an entry is applied as stored.
 */
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
