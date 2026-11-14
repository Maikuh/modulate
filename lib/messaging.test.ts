import { describe, it, expect, beforeEach, vi } from 'vitest'

import { parseApplyMessage, type ApplyMessage } from '@/lib/messaging'
import { MAX_SEMITONES, MAX_TEMPO, MIN_TEMPO } from '@/lib/settings'

const valid: ApplyMessage = {
	source: 'modulate',
	type: 'apply',
	semitones: 3,
	tempo: 1.25,
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
		expect(parse({ ...valid, tempo: undefined })).toBeNull()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('tempo'))
	})

	// The page script finds the worklet itself; a URL on the wire (sent for 1.4-era
	// page scripts, or forged) must not survive parsing to reach `addModule`.
	it('drops any processorUrl it is sent', () => {
		const parsed = parse({ ...valid, processorUrl: 'https://evil.example/w.js' })
		expect(parsed).toEqual(valid)
		expect(parsed).not.toHaveProperty('processorUrl')
	})

	// Any MAIN-world script can post here, and an out-of-range value reaches
	// `element.playbackRate`, a restricted float that throws.
	it('clamps numbers onto the storage ranges', () => {
		expect(parse({ ...valid, semitones: 1e6, tempo: 100 })).toMatchObject({
			semitones: MAX_SEMITONES,
			tempo: MAX_TEMPO,
		})
		expect(parse({ ...valid, tempo: 0.01 })).toMatchObject({ tempo: MIN_TEMPO })
	})
})
