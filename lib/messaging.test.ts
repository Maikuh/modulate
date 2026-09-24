import { describe, it, expect, beforeEach, vi } from 'vitest'

import { MAX_OVERLAP_MS } from '@/lib/audioQuality'
import { parseApplyMessage, type ApplyMessage } from '@/lib/messaging'
import { MAX_SEMITONES, MAX_TEMPO, MIN_TEMPO } from '@/lib/settings'

const valid: ApplyMessage = {
	source: 'modulate',
	type: 'apply',
	processorUrl: 'moz-extension://abc/soundtouch-processor.js',
	semitones: 3,
	tempo: 1.25,
	overlapMs: 12,
	quickSeek: true,
}

const parse = (m: unknown) => parseApplyMessage(JSON.stringify(m))

describe('parseApplyMessage', () => {
	let warn: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	})

	it('round-trips a valid message', () => {
		expect(parse(valid)).toEqual(valid)
	})

	it('ignores foreign payloads silently', () => {
		expect(parseApplyMessage('not json')).toBeNull()
		expect(parse({ source: 'someone-else', type: 'apply' })).toBeNull()
		expect(parse(42)).toBeNull()
		expect(warn).not.toHaveBeenCalled()
	})

	// A payload carrying our marker but a bad field is either a version skew or a
	// forgery; either way the drop must leave a trace rather than stop audio unseen.
	it('warns, naming the field, when one of ours is malformed', () => {
		expect(parse({ ...valid, overlapMs: undefined })).toBeNull()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlapMs'))
	})

	it('rejects a processorUrl that is not an extension URL', () => {
		expect(parse({ ...valid, processorUrl: 'https://evil.example/w.js' })).toBeNull()
	})

	// Any MAIN-world script can post here, and an out-of-range value reaches
	// restricted-float writes (`playbackRate`, `AudioParam.value`) that throw.
	it('clamps numbers onto the storage ranges', () => {
		expect(parse({ ...valid, semitones: 1e6, tempo: 100, overlapMs: 500 })).toMatchObject({
			semitones: MAX_SEMITONES,
			tempo: MAX_TEMPO,
			overlapMs: MAX_OVERLAP_MS,
		})
		expect(parse({ ...valid, tempo: 0.01 })).toMatchObject({ tempo: MIN_TEMPO })
	})
})
