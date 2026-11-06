import { describe, expect, it } from 'vitest'

import {
	HOLD,
	QUANTUM,
	SR,
	drive,
	pacedPipe as paced,
	semitoneRatio as semitones,
	stockPipe as stock,
} from '@/lib/testing/pipeSim'

/** Frequency from upward zero crossings over the settled tail. */
function frequency(signal: number[]): number {
	const tail = signal.slice(SR)
	let crossings = 0
	for (let i = 1; i < tail.length; i++) if (tail[i - 1]! < 0 && tail[i]! >= 0) crossings++
	return (crossings * SR) / tail.length
}

describe('PacedPipe', () => {
	it.each([12, 5, -7])('shifts %i semitones', (n) => {
		const { out } = drive(paced(), () => semitones(n), 3)
		expect(frequency(out) / 330).toBeCloseTo(semitones(n), 2)
	})

	it.each([12, -12])('keeps up with the input at %i semitones', (n) => {
		// Only what the stretch holds for its window (≤150 ms), plus the cushion, stays behind.
		const { playedFrames } = drive(paced(), () => semitones(n), 3)
		expect(playedFrames).toBeGreaterThan(SR * 3 - SR * 0.15 - HOLD)
	})

	it('spreads the transposer work across quanta when shifting up', () => {
		// The stock pipeline converts a whole stretch window in one quantum; paced, no
		// quantum produces more than PACE quanta of output once the output is primed.
		const settle = SR / QUANTUM
		const stockPeak = Math.max(...drive(stock(), () => semitones(5), 3).produced.slice(settle))
		const pacedPeak = Math.max(...drive(paced(), () => semitones(5), 3).produced.slice(settle))
		expect(stockPeak).toBeGreaterThan(10 * QUANTUM)
		expect(pacedPeak).toBeLessThanOrEqual(2 * QUANTUM + 1)
	})

	it.each([
		[-3, 7],
		[-7, 12],
		[0, 9],
		[7, -3],
	])('plays no more silence than stock when changing %i → %i', (from, to) => {
		const pitchAt = (s: number) => semitones(s < 2 ? from : to)
		const silent = (played: number[]) => played.filter((k) => k < QUANTUM).length
		expect(silent(drive(paced(), pitchAt, 3).played)).toBeLessThanOrEqual(
			silent(drive(stock(), pitchAt, 3).played),
		)
	})
})
