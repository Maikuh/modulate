import { describe, expect, it } from 'vitest'

import { QUANTUM, SR, drive, firstAbove, onset, pacedPipe, pipePitch } from '@/lib/testing/pipeSim'

/**
 * The whole worklet pipeline (paced pipe + output cushion + band-limited kernel)
 * across the settings that reach it — a transpose, with or without a tempo; tempo
 * alone is the element's native time-stretch and never gets here.
 *
 * These are the offline measurements the crackle fixes were tuned against, kept as
 * regression guards. They model the DSP only: a real worklet can still miss a
 * render deadline (the Firefox cracks were that), which no offline run can show.
 */

const SEMITONES = [-12, -7, -1, 1, 7, 12]
const TEMPOS = [0.5, 1, 2]
const GRID = SEMITONES.flatMap((st) => TEMPOS.map((tempo) => [st, tempo] as const))

/** A tone that starts after one second, once the pipeline is primed. */
const ONSET = SR

function run(semitones: number, tempo: number) {
	return drive(pacedPipe(), () => pipePitch(semitones, tempo), 2, onset(ONSET))
}

describe('worklet pipeline', () => {
	// A quantum played short is zeros spliced into the waveform: an audible click.
	it.each(GRID)('never runs dry once playing (%i st, %f×)', (semitones, tempo) => {
		const { played } = run(semitones, tempo)
		expect(played.filter((k) => k < QUANTUM)).toEqual([])
	})

	// The video isn't delayed to match, so this is how far the audio trails the
	// picture (before the context's own output latency, which only a browser can
	// report). Measured at 80–175 ms across the grid: the WSOLA window plus the 20 ms
	// cushion. A guard against creeping further, not a target.
	it.each(GRID)('trails the input by under 200 ms (%i st, %f×)', (semitones, tempo) => {
		const { out } = run(semitones, tempo)
		const heard = firstAbove(out, 0.05, ONSET)
		expect(heard).toBeGreaterThan(ONSET)
		expect(((heard - ONSET) / SR) * 1000).toBeLessThan(200)
	})
})
