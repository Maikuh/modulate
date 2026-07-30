import { describe, it, expect, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import {
	resolveSetting,
	clampSemitones,
	clampTempo,
	MIN_SEMITONES,
	MAX_SEMITONES,
	MIN_TEMPO,
	MAX_TEMPO,
	globalEnabled,
	audioQuality,
	DEFAULT_AUDIO_QUALITY,
	DEFAULT_VIDEO_SETTING,
	getRawVideoSetting,
	setVideoSetting,
	listVideoSettings,
	removeVideoSetting,
	clearVideoSettings,
	type VideoSetting,
} from '@/lib/storage'

describe('resolveSetting', () => {
	const enabled: VideoSetting = { enabled: true, semitones: 5, tempo: 1.5 }

	it('is a no-op when the global switch is off', () => {
		expect(resolveSetting(false, enabled)).toEqual({ semitones: 0, tempo: 1 })
	})

	it('is a no-op when no per-video entry exists', () => {
		expect(resolveSetting(true, undefined)).toEqual({ semitones: 0, tempo: 1 })
	})

	it('is a no-op when the per-video entry is disabled', () => {
		const disabled: VideoSetting = { ...enabled, enabled: false }
		expect(resolveSetting(true, disabled)).toEqual({ semitones: 0, tempo: 1 })
	})

	it('applies the entry values when global on + entry enabled', () => {
		expect(resolveSetting(true, enabled)).toEqual({ semitones: 5, tempo: 1.5 })
	})
})

describe('clampSemitones', () => {
	it('rounds floats to the nearest integer', () => {
		expect(clampSemitones(2.6)).toBe(3)
		expect(clampSemitones(2.4)).toBe(2)
	})

	it('clamps to the ±12 range', () => {
		expect(clampSemitones(99)).toBe(MAX_SEMITONES)
		expect(clampSemitones(-99)).toBe(MIN_SEMITONES)
	})

	it('passes through in-range integers', () => {
		expect(clampSemitones(0)).toBe(0)
		expect(clampSemitones(-7)).toBe(-7)
	})

	// NaN survives Math.round/min/max, so without an explicit guard it reaches
	// AudioParam.value and throws mid-reroute, leaving the video muted.
	it('falls back to the default for non-finite and non-numeric input', () => {
		expect(clampSemitones(Number.NaN)).toBe(DEFAULT_VIDEO_SETTING.semitones)
		expect(clampSemitones(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VIDEO_SETTING.semitones)
		expect(clampSemitones('3' as unknown as number)).toBe(DEFAULT_VIDEO_SETTING.semitones)
	})
})

describe('clampTempo', () => {
	it('snaps to the 0.05 step grid', () => {
		expect(clampTempo(1.234)).toBe(1.25)
		expect(clampTempo(1.21)).toBe(1.2)
	})

	it('clamps to the 0.5–2 range', () => {
		expect(clampTempo(0.1)).toBe(MIN_TEMPO)
		expect(clampTempo(3)).toBe(MAX_TEMPO)
	})

	it('keeps 2-decimal precision (no float drift)', () => {
		expect(clampTempo(1)).toBe(1)
		expect(clampTempo(1.05)).toBe(1.05)
	})

	// A tempo of 0 reaches element.playbackRate and freezes the video outright;
	// NaN throws. Neither may survive the clamp.
	it('falls back to the default for non-finite and non-numeric input', () => {
		expect(clampTempo(Number.NaN)).toBe(DEFAULT_VIDEO_SETTING.tempo)
		expect(clampTempo(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VIDEO_SETTING.tempo)
		expect(clampTempo('1.5' as unknown as number)).toBe(DEFAULT_VIDEO_SETTING.tempo)
	})

	it('lifts 0 to the minimum rather than freezing playback', () => {
		expect(clampTempo(0)).toBe(MIN_TEMPO)
	})
})

// Storage round-trips run against WxtVitest's in-memory fake browser.
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

	it('clears all entries', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await setVideoSetting('b', { semitones: 2 })
		await clearVideoSettings()
		expect(await listVideoSettings()).toEqual({})
	})
})

// `storage.defineItem`'s type parameter is an unchecked assertion — its `fallback`
// only fires when the key is ABSENT, so whatever is actually stored arrives typed
// as a VideoSetting without ever having been validated. These pin the normalize
// step that stands between storage and `element.playbackRate`.
describe('range enforcement at the storage boundary', () => {
	beforeEach(() => fakeBrowser.reset())

	/** Write straight past `setVideoSetting` to simulate a corrupt/legacy entry. */
	async function seedRaw(entries: Record<string, unknown>): Promise<void> {
		await fakeBrowser.storage.local.set({ videoSettings: entries })
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

	it('audioQuality defaults to DEFAULT_AUDIO_QUALITY', async () => {
		expect(await audioQuality.getValue()).toEqual(DEFAULT_AUDIO_QUALITY)
	})
})
