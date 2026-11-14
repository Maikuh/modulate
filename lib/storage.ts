import { storage } from 'wxt/utils/storage'

import {
	DEFAULT_VIDEO_SETTING,
	clampSemitones,
	clampTempo,
	isNoOp,
	type VideoSetting,
} from '@/lib/settings'

/**
 * Force a stored entry onto the valid ranges, or `undefined` when it isn't an
 * entry at all. Applied on every read AND every write, because nothing types what
 * actually sits in `chrome.storage.local` — written by an older version, edited
 * from devtools, or (on the ROADMAP) synced from another device — so it arrives
 * typed as a `VideoSetting` without ever having been one. Missing fields take
 * their defaults.
 *
 * Built field by field rather than spread: a spread would carry unknown keys back
 * into storage forever, and an unchecked non-string `title` makes Preact throw
 * while rendering the options list.
 */
function normalize(raw: unknown): VideoSetting | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const setting = { ...DEFAULT_VIDEO_SETTING, ...raw } as VideoSetting
	const out: VideoSetting = {
		enabled: setting.enabled !== false,
		semitones: clampSemitones(setting.semitones),
		tempo: clampTempo(setting.tempo),
	}
	if (typeof setting.title === 'string') out.title = setting.title
	if (Number.isFinite(setting.updatedAt)) out.updatedAt = setting.updatedAt
	return out
}

/** Global master switch. When off, every video plays untransposed. */
export const globalEnabled = storage.defineItem<boolean>('local:globalEnabled', {
	fallback: true,
})

/**
 * Per-video settings live under one key each (`local:video:<id>`), not in one
 * shared object. A shared object makes every write a read-modify-write of every
 * video's entry, which the content script can only serialize within its own tab —
 * two YouTube tabs (or the options page and a tab) writing at once would lose one
 * of the writes. Per-key, each write touches only its own video.
 */
const VIDEO_KEY_PREFIX = 'video:'
const videoKey = (videoId: string) => `local:${VIDEO_KEY_PREFIX}${videoId}` as const

/** The pre-1.4 layout: every entry in one `Record<videoId, VideoSetting>`. */
const LEGACY_VIDEO_SETTINGS_KEY = 'local:videoSettings'

/** Pre-1.4 SoundTouch tuning knobs; the Signalsmith engine has no equivalent. */
const LEGACY_AUDIO_QUALITY_KEY = 'local:audioQuality'

/**
 * The stored entry for `videoId`, merged over the defaults and normalized, or
 * `undefined` when none is stored. `resolveSetting` relies on that distinction:
 * no entry means the no-op, while an entry is applied as stored.
 */
export async function getRawVideoSetting(videoId: string): Promise<VideoSetting | undefined> {
	return normalize(await storage.getItem(videoKey(videoId)))
}

export async function setVideoSetting(
	videoId: string,
	partial: Partial<VideoSetting>,
): Promise<VideoSetting> {
	const stored = await storage.getItem(videoKey(videoId))
	// Drop `undefined` fields so a partial can't blank out a stored value (e.g. a
	// null title before the watch metadata mounts must not erase a saved one).
	const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined))
	// Clamp here rather than at each call site: this is the only way a value enters
	// storage, so enforcing the range at the mutator means callers can't forget.
	// "Last tuned", not "last written": switching a video on or off, or a title
	// catching up, doesn't move it to the top of the options list.
	const tuned = 'semitones' in defined || 'tempo' in defined
	const previous = normalize(stored)
	const next = normalize({
		...previous,
		...defined,
		updatedAt: tuned ? Date.now() : previous?.updatedAt,
	})!

	// Prune rather than store an enabled entry sitting at the no-op: `resolveSetting`
	// cannot tell it apart from having no entry at all, so it holds no information
	// the user could lose. This also makes RESET self-cleaning and keeps the options
	// list (and a future `sync` quota) to videos actually tuned.
	//
	// A DISABLED entry is kept even at the no-op: "off for this video" is a choice
	// the user made, and it has to survive to be shown and toggled back on.
	if (next.enabled && isNoOp(next)) {
		if (stored !== null) await storage.removeItem(videoKey(videoId))
		return next
	}

	await storage.setItem(videoKey(videoId), next)
	return next
}

/** Every stored entry, keyed by the raw storage key's video id. */
async function storedVideoEntries(): Promise<Array<[string, unknown]>> {
	const all = await storage.snapshot('local')
	return Object.entries(all).flatMap(([key, value]): Array<[string, unknown]> =>
		key.startsWith(VIDEO_KEY_PREFIX) && !key.endsWith('$')
			? [[key.slice(VIDEO_KEY_PREFIX.length), value]]
			: [],
	)
}

export async function listVideoSettings(): Promise<Record<string, VideoSetting>> {
	// Normalized like the single-entry accessor. Without this the options page
	// reads entries raw, and one missing field (a legacy write, a downgrade) makes
	// `s.tempo.toFixed(2)` throw during render — blanking the whole page, including
	// the controls that would delete the offending entry.
	return Object.fromEntries(
		(await storedVideoEntries()).flatMap(([id, raw]) => {
			const setting = normalize(raw)
			return setting ? [[id, setting]] : []
		}),
	)
}

export async function removeVideoSetting(videoId: string): Promise<void> {
	await storage.removeItem(videoKey(videoId))
}

export async function clearVideoSettings(): Promise<void> {
	const ids = (await storedVideoEntries()).map(([id]) => id)
	if (ids.length > 0) await storage.removeItems(ids.map(videoKey))
}

/**
 * Call `cb` with the ids of the videos whose settings changed, on any write from
 * anywhere (another tab, the options page). Returns the unsubscribe.
 */
export function watchVideoSettings(cb: (videoIds: string[]) => void): () => void {
	const listener = (changes: Record<string, unknown>, area: string) => {
		if (area !== 'local') return
		const ids = Object.keys(changes)
			.filter((key) => key.startsWith(VIDEO_KEY_PREFIX) && !key.endsWith('$'))
			.map((key) => key.slice(VIDEO_KEY_PREFIX.length))
		if (ids.length > 0) cb(ids)
	}
	browser.storage.onChanged.addListener(listener)
	return () => browser.storage.onChanged.removeListener(listener)
}

/**
 * Bring a pre-1.4 install's storage up to date. Idempotent and a couple of reads
 * once done, so it can run on every background start.
 */
export async function migrateLegacyStorage(): Promise<void> {
	await migrateLegacyVideoSettings()
	await storage.removeItem(LEGACY_AUDIO_QUALITY_KEY)
}

/**
 * Move entries from the single-object layout to one key per video, then drop the
 * old object. An entry already stored under its own key wins: it was written after
 * the update.
 */
async function migrateLegacyVideoSettings(): Promise<void> {
	const legacy = await storage.getItem<Record<string, unknown>>(LEGACY_VIDEO_SETTINGS_KEY)
	if (legacy === null) return
	if (typeof legacy === 'object') {
		const ids = Object.keys(legacy)
		const existing = new Map(
			(await storage.getItems(ids.map(videoKey))).map(({ key, value }) => [key, value]),
		)
		const writes = ids.flatMap((id) => {
			const setting = normalize(legacy[id])
			if (!setting || existing.get(videoKey(id)) != null) return []
			// The no-op pruning rule holds for migrated entries too.
			if (setting.enabled && isNoOp(setting)) return []
			return [{ key: videoKey(id), value: setting }]
		})
		if (writes.length > 0) await storage.setItems(writes)
	}
	await storage.removeItem(LEGACY_VIDEO_SETTINGS_KEY)
}
