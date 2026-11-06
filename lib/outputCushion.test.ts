import { describe, expect, it } from 'vitest'

import { OutputCushion } from '@/lib/outputCushion'

const Q = 128

describe('OutputCushion', () => {
	it('outputs nothing until the pipeline has produced for the hold time', () => {
		const cushion = new OutputCushion(3 * Q)
		// Pipeline still filling its first window: the clock doesn't start.
		expect(cushion.take(0, Q)).toBe(0)
		expect(cushion.take(0, Q)).toBe(0)
		// Producing: held for three quanta, even though a full quantum is available.
		expect(cushion.take(2000, Q)).toBe(0)
		expect(cushion.take(2128, Q)).toBe(0)
		expect(cushion.take(2256, Q)).toBe(Q)
		expect(cushion.take(2256, Q)).toBe(Q)
	})

	it('plays what is left on a shortfall, then rebuilds the cushion', () => {
		const cushion = new OutputCushion(2 * Q)
		cushion.take(500, Q)
		expect(cushion.take(600, Q)).toBe(Q)
		// Ran dry: hand over the partial quantum instead of dropping it...
		expect(cushion.take(50, Q)).toBe(50)
		// ...then hold again before resuming.
		expect(cushion.take(0, Q)).toBe(0)
		expect(cushion.take(400, Q)).toBe(0)
		expect(cushion.take(528, Q)).toBe(Q)
	})

	it('never holds when the hold is zero', () => {
		const cushion = new OutputCushion(0)
		expect(cushion.take(64, Q)).toBe(64)
		expect(cushion.take(300, Q)).toBe(Q)
	})
})
