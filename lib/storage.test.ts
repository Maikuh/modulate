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
	getVideoSetting,
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
})

// Storage round-trips run against WxtVitest's in-memory fake browser.
describe('video settings round-trip', () => {
	beforeEach(() => fakeBrowser.reset())

	it('writes then reads a per-video setting', async () => {
		await setVideoSetting('abc', { semitones: 3, tempo: 1.25 })
		expect(await getVideoSetting('abc')).toEqual({
			enabled: true,
			semitones: 3,
			tempo: 1.25,
		})
	})

	it('merges defaults into a partial write', async () => {
		await setVideoSetting('abc', { semitones: 2 })
		expect(await getVideoSetting('abc')).toEqual({
			...DEFAULT_VIDEO_SETTING,
			semitones: 2,
		})
	})

	it('getVideoSetting returns merged defaults when absent', async () => {
		expect(await getVideoSetting('missing')).toEqual(DEFAULT_VIDEO_SETTING)
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

describe('storage item fallbacks', () => {
	beforeEach(() => fakeBrowser.reset())

	it('globalEnabled defaults to true', async () => {
		expect(await globalEnabled.getValue()).toBe(true)
	})

	it('audioQuality defaults to DEFAULT_AUDIO_QUALITY', async () => {
		expect(await audioQuality.getValue()).toEqual(DEFAULT_AUDIO_QUALITY)
	})
})
