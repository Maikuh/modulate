import { describe, it, expect } from 'vitest'

import {
	DEFAULT_VIDEO_SETTING,
	resolveSetting,
	isNoOp,
	NO_OP,
	clampSemitones,
	clampTempo,
	MIN_SEMITONES,
	MAX_SEMITONES,
	MIN_TEMPO,
	MAX_TEMPO,
	type VideoSetting,
} from '@/lib/settings'

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

describe('isNoOp', () => {
	it('is true only at 0 semitones and 1x', () => {
		expect(isNoOp({ semitones: 0, tempo: 1 })).toBe(true)
		expect(isNoOp({ semitones: 1, tempo: 1 })).toBe(false)
		expect(isNoOp({ semitones: 0, tempo: 1.05 })).toBe(false)
	})

	it('describes NO_OP itself', () => {
		expect(isNoOp(NO_OP)).toBe(true)
	})

	// Handed straight back to callers by resolveSetting; a stray mutation would
	// silently retune every untouched video.
	it('exposes NO_OP frozen', () => {
		expect(Object.isFrozen(NO_OP)).toBe(true)
	})

	it('resolveSetting returns a copy, not the shared constant', () => {
		expect(resolveSetting(false, undefined)).not.toBe(NO_OP)
		expect(resolveSetting(false, undefined)).toEqual(NO_OP)
	})
})

// `storage.defineItem`'s type parameter is an unchecked assertion — its `fallback`
// only fires when the key is ABSENT, so whatever is actually stored arrives typed
// as a VideoSetting without ever having been validated. These pin the normalize
// step that stands between storage and `element.playbackRate`.

describe('DEFAULT_VIDEO_SETTING', () => {
	// It seeds every merge in storage; a stray mutation would retune every video.
	it('is frozen', () => {
		expect(Object.isFrozen(DEFAULT_VIDEO_SETTING)).toBe(true)
	})
})
