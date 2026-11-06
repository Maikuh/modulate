import { describe, it, expect, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import {
	DEFAULT_VIDEO_SETTING,
	MAX_SEMITONES,
	MAX_TEMPO,
	MIN_SEMITONES,
	MIN_TEMPO,
	resolveSetting,
} from '@/lib/settings'
import {
	globalEnabled,
	getRawVideoSetting,
	setVideoSetting,
	listVideoSettings,
	removeVideoSetting,
	clearVideoSettings,
	watchVideoSettings,
	migrateLegacyStorage,
} from '@/lib/storage'

describe('video settings round-trip', () => {
	beforeEach(() => fakeBrowser.reset())

	it('writes then reads a per-video setting', async () => {
		await setVideoSetting('abc', { semitones: 3, tempo: 1.25 })
		expect(await getRawVideoSetting('abc')).toEqual({
			enabled: true,
			semitones: 3,
			tempo: 1.25,
		})
	})

	it('merges defaults into a partial write', async () => {
		await setVideoSetting('abc', { semitones: 2 })
		expect(await getRawVideoSetting('abc')).toEqual({
			...DEFAULT_VIDEO_SETTING,
			semitones: 2,
		})
	})

	it('getRawVideoSetting returns undefined when no explicit entry', async () => {
		expect(await getRawVideoSetting('missing')).toBeUndefined()
		await setVideoSetting('abc', { semitones: 1 })
		expect(await getRawVideoSetting('abc')).toMatchObject({ semitones: 1 })
	})

	it('lists all saved entries', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await setVideoSetting('b', { tempo: 1.5 })
		expect(Object.keys(await listVideoSettings()).sort()).toEqual(['a', 'b'])
	})

	it('removes one entry, no-ops when absent', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await removeVideoSetting('missing') // should not throw
		await removeVideoSetting('a')
		expect(await listVideoSettings()).toEqual({})
	})

	it('clears all entries, and nothing else', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await setVideoSetting('b', { semitones: 2 })
		await globalEnabled.setValue(false)
		await clearVideoSettings()
		expect(await listVideoSettings()).toEqual({})
		expect(await globalEnabled.getValue()).toBe(false)
	})

	// Each tab serializes only its own writes. With every video in one object, two
	// tabs writing at once read the same snapshot and the second write drops the first.
	it('keeps concurrent writes for different videos', async () => {
		await Promise.all([
			setVideoSetting('a', { semitones: 1 }),
			setVideoSetting('b', { semitones: 2 }),
			setVideoSetting('c', { tempo: 1.5 }),
		])
		expect(Object.keys(await listVideoSettings()).sort()).toEqual(['a', 'b', 'c'])
	})

	it('reports which videos changed to a watcher', async () => {
		const seen: string[][] = []
		const off = watchVideoSettings((ids) => seen.push(ids))

		await setVideoSetting('a', { semitones: 1 })
		await globalEnabled.setValue(false)
		await removeVideoSetting('a')
		off()
		await setVideoSetting('b', { semitones: 1 })

		expect(seen).toEqual([['a'], ['a']])
	})
})

describe('legacy layout migration', () => {
	beforeEach(() => fakeBrowser.reset())

	it('moves every entry to its own key and drops the old object', async () => {
		await fakeBrowser.storage.local.set({
			videoSettings: {
				a: { enabled: true, semitones: 3, tempo: 1, title: 'Song' },
				b: { enabled: false, semitones: 0, tempo: 1 },
			},
		})

		await migrateLegacyStorage()

		expect(await listVideoSettings()).toEqual({
			a: { enabled: true, semitones: 3, tempo: 1, title: 'Song' },
			b: { enabled: false, semitones: 0, tempo: 1 },
		})
		expect(await fakeBrowser.storage.local.get('videoSettings')).toEqual({})
	})

	it('keeps an entry written under its own key since the update', async () => {
		await fakeBrowser.storage.local.set({ videoSettings: { a: { semitones: 3 } } })
		await setVideoSetting('a', { semitones: -2 })

		await migrateLegacyStorage()

		expect(await getRawVideoSetting('a')).toMatchObject({ semitones: -2 })
	})

	it('normalizes and prunes on the way', async () => {
		await fakeBrowser.storage.local.set({
			videoSettings: { a: { semitones: 99 }, dead: { enabled: true, semitones: 0 }, junk: 7 },
		})

		await migrateLegacyStorage()

		expect(await listVideoSettings()).toEqual({
			a: { enabled: true, semitones: MAX_SEMITONES, tempo: 1 },
		})
	})

	// The old engine's WSOLA knobs mean nothing to Signalsmith.
	it('drops the old engine tuning', async () => {
		await fakeBrowser.storage.local.set({ audioQuality: { overlapMs: 12, quickSeek: true } })
		await migrateLegacyStorage()
		expect(await fakeBrowser.storage.local.get('audioQuality')).toEqual({})
	})

	it('does nothing once migrated', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await migrateLegacyStorage()
		expect(Object.keys(await listVideoSettings())).toEqual(['a'])
	})
})

// An ENABLED entry at the no-op holds nothing: resolveSetting cannot tell it from
// having no entry. Pruning keeps storage (and a future sync quota) to videos tuned.
describe('no-op pruning', () => {
	beforeEach(() => fakeBrowser.reset())

	it('removes an entry that is set back to the no-op', async () => {
		await setVideoSetting('abc', { semitones: 5 })
		expect(await getRawVideoSetting('abc')).toBeDefined()

		await setVideoSetting('abc', { semitones: 0 })

		expect(await getRawVideoSetting('abc')).toBeUndefined()
		expect(await listVideoSettings()).toEqual({})
	})

	it('removes an entry whose tempo is set back to 1', async () => {
		await setVideoSetting('abc', { tempo: 1.5 })
		await setVideoSetting('abc', { tempo: 1 })
		expect(await listVideoSettings()).toEqual({})
	})

	it('keeps an entry while either pitch or tempo is still set', async () => {
		await setVideoSetting('abc', { semitones: 5, tempo: 1.5 })
		await setVideoSetting('abc', { semitones: 0 })
		expect(await getRawVideoSetting('abc')).toMatchObject({ semitones: 0, tempo: 1.5 })
	})

	// "Off for this video" is a choice the user made; it has to survive to be
	// listed and toggled back on.
	it('keeps a disabled entry even at the no-op', async () => {
		await setVideoSetting('abc', { enabled: false })
		expect(await getRawVideoSetting('abc')).toMatchObject({
			enabled: false,
			semitones: 0,
			tempo: 1,
		})
	})

	it('drops a disabled no-op entry once it is re-enabled', async () => {
		await setVideoSetting('abc', { enabled: false })
		await setVideoSetting('abc', { enabled: true })
		expect(await listVideoSettings()).toEqual({})
	})

	it('never creates an entry for a no-op write', async () => {
		await setVideoSetting('abc', { semitones: 0, tempo: 1 })
		expect(await listVideoSettings()).toEqual({})
	})

	// RESET writes DEFAULT_VIDEO_SETTING, which is the no-op, so it self-cleans.
	it('makes RESET remove the entry rather than blank it', async () => {
		await setVideoSetting('abc', { semitones: 7, title: 'Song' })
		await setVideoSetting('abc', { ...DEFAULT_VIDEO_SETTING, title: 'Song' })
		expect(await listVideoSettings()).toEqual({})
	})

	it('still returns the resolved values it wrote', async () => {
		expect(await setVideoSetting('abc', { semitones: 0 })).toEqual(DEFAULT_VIDEO_SETTING)
	})

	it('leaves other videos untouched', async () => {
		await setVideoSetting('keep', { semitones: 4 })
		await setVideoSetting('drop', { semitones: 2 })
		await setVideoSetting('drop', { semitones: 0 })
		expect(Object.keys(await listVideoSettings())).toEqual(['keep'])
	})
})

describe('range enforcement at the storage boundary', () => {
	beforeEach(() => fakeBrowser.reset())

	/** Write straight past `setVideoSetting` to simulate a corrupt/legacy entry. */
	async function seedRaw(entries: Record<string, unknown>): Promise<void> {
		await fakeBrowser.storage.local.set(
			Object.fromEntries(Object.entries(entries).map(([id, v]) => [`video:${id}`, v])),
		)
	}

	it('clamps on write, so no call site can persist an out-of-range value', async () => {
		await setVideoSetting('abc', { semitones: 99, tempo: 9 })
		expect(await getRawVideoSetting('abc')).toMatchObject({
			semitones: MAX_SEMITONES,
			tempo: MAX_TEMPO,
		})
	})

	it('clamps a nudge that would overshoot the range', async () => {
		await setVideoSetting('abc', { semitones: MAX_SEMITONES })
		await setVideoSetting('abc', { semitones: MAX_SEMITONES + 5 })
		expect(await getRawVideoSetting('abc')).toMatchObject({ semitones: MAX_SEMITONES })
	})

	it('normalizes an out-of-range entry on read', async () => {
		await seedRaw({ abc: { enabled: true, semitones: 500, tempo: 50 } })
		expect(await getRawVideoSetting('abc')).toEqual({
			enabled: true,
			semitones: MAX_SEMITONES,
			tempo: MAX_TEMPO,
		})
	})

	it('replaces a NaN tempo on read instead of passing it to the audio graph', async () => {
		await seedRaw({ abc: { enabled: true, semitones: 0, tempo: Number.NaN } })
		expect(await getRawVideoSetting('abc')).toMatchObject({ tempo: DEFAULT_VIDEO_SETTING.tempo })
	})

	// A non-string title reaches the options list as a Preact child and throws
	// during render; unknown keys would otherwise be written back forever.
	it('keeps only known fields, and a title only when it is a string', async () => {
		await seedRaw({
			abc: { enabled: true, semitones: 2, tempo: 1, title: { bad: true }, junk: 1 },
			def: { enabled: true, semitones: 3, tempo: 1, title: 'Song' },
		})
		expect(await listVideoSettings()).toEqual({
			abc: { enabled: true, semitones: 2, tempo: 1 },
			def: { enabled: true, semitones: 3, tempo: 1, title: 'Song' },
		})

		await setVideoSetting('abc', { semitones: 4 })
		const stored = await fakeBrowser.storage.local.get('video:abc')
		expect(stored['video:abc']).toEqual({ enabled: true, semitones: 4, tempo: 1 })
	})

	it('backfills a legacy entry that predates a field', async () => {
		await seedRaw({ abc: { enabled: true, semitones: 3 } })
		expect(await getRawVideoSetting('abc')).toEqual({
			enabled: true,
			semitones: 3,
			tempo: DEFAULT_VIDEO_SETTING.tempo,
		})
	})

	// The options page renders `s.tempo.toFixed(2)`; an unmerged entry would throw
	// during render and blank the page, including the controls that would fix it.
	it('listVideoSettings merges defaults like the single-entry accessors', async () => {
		await seedRaw({ abc: { enabled: true, semitones: 3 } })
		const all = await listVideoSettings()
		expect(all.abc).toEqual({
			enabled: true,
			semitones: 3,
			tempo: DEFAULT_VIDEO_SETTING.tempo,
		})
	})

	it('treats a value that is not an entry as no entry', async () => {
		await seedRaw({ abc: 'garbage', def: null })
		expect(await getRawVideoSetting('abc')).toBeUndefined()
		expect(await listVideoSettings()).toEqual({})
	})

	it('resolveSetting yields applied values that are always in range', async () => {
		await seedRaw({ abc: { enabled: true, semitones: -500, tempo: 0 } })
		const entry = await getRawVideoSetting('abc')
		expect(resolveSetting(true, entry)).toEqual({
			semitones: MIN_SEMITONES,
			tempo: MIN_TEMPO,
		})
	})
})

describe('storage item fallbacks', () => {
	beforeEach(() => fakeBrowser.reset())

	it('globalEnabled defaults to true', async () => {
		expect(await globalEnabled.getValue()).toBe(true)
	})
})
