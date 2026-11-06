import { registerInterpolationStrategy, SoundTouch } from '@soundtouchjs/core'
import { describe, expect, it } from 'vitest'

import { BANDLIMITED_STRATEGY_ID, bandlimitedKernel } from '@/lib/bandlimitedKernel'
import { OutputCushion } from '@/lib/outputCushion'
import { PacedPipe } from '@/lib/pacedPipe'

registerInterpolationStrategy({ id: BANDLIMITED_STRATEGY_ID, kernel: bandlimitedKernel })

const SR = 48_000
const QUANTUM = 128
/** As the processor configures them: a 20 ms cushion, low water a quantum above it. */
const HOLD = 960
const LOW_WATER = HOLD + QUANTUM

type Pipe = Pick<SoundTouch, 'inputBuffer' | 'outputBuffer' | 'process'> & { pitch: number }

const semitones = (n: number) => 2 ** (n / 12)

/**
 * Drive a pipe like the processor does: set the pitch, push one render quantum of a
 * sine, process, then play what `OutputCushion` allows. Records the output (left
 * channel), how much output each quantum produced (its work), and how many frames
 * each quantum played once playback had started (short of a quantum = silence).
 */
function drive(pipe: Pipe, pitchAt: (seconds: number) => number, seconds: number, freq = 330) {
	const cushion = new OutputCushion(HOLD)
	const out: number[] = []
	const produced: number[] = []
	const played: number[] = []
	const block = new Float32Array(QUANTUM * 2)
	let t = 0
	for (let b = 0; b < (SR * seconds) / QUANTUM; b++) {
		pipe.pitch = pitchAt((b * QUANTUM) / SR)
		for (let i = 0; i < QUANTUM; i++, t++) {
			block[2 * i] = block[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * freq * t) / SR)
		}
		const before = pipe.outputBuffer.frameCount
		pipe.inputBuffer.putSamples(block, 0, QUANTUM)
		pipe.process()
		const level = pipe.outputBuffer.frameCount
		produced.push(level - before)
		const k = cushion.take(level, QUANTUM)
		if (out.length > 0) played.push(k)
		const o = new Float32Array(k * 2)
		pipe.outputBuffer.extract(o, 0, k)
		pipe.outputBuffer.receive(k)
		for (let i = 0; i < k; i++) out.push(o[2 * i]!)
	}
	return { out, produced, played }
}

const paced = () => new PacedPipe(SR, BANDLIMITED_STRATEGY_ID, LOW_WATER)
const stock = () =>
	new SoundTouch({ sampleRate: SR, interpolationStrategy: BANDLIMITED_STRATEGY_ID })

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
		const { out } = drive(paced(), () => semitones(n), 3)
		expect(out.length).toBeGreaterThan(SR * 3 - SR * 0.15 - HOLD)
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
