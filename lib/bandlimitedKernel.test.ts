import { RateTransposer, registerInterpolationStrategy } from '@soundtouchjs/core'
import { describe, expect, it } from 'vitest'

import { BANDLIMITED_STRATEGY_ID, bandlimitedKernel, cutoffFor } from '@/lib/bandlimitedKernel'

registerInterpolationStrategy({ id: BANDLIMITED_STRATEGY_ID, kernel: bandlimitedKernel })

const SR = 48_000
const F0 = 220
/** A band-limited sawtooth up to 20 kHz: bright, like real music near YouTube's cutoff. */
const HARMONICS = Math.floor(20_000 / F0)
const AUDIBLE = 20_000

function saw(t: number, keep: (freq: number) => boolean = () => true): number {
	let v = 0
	for (let h = 1; h <= HARMONICS; h++) if (keep(F0 * h)) v += Math.sin(2 * Math.PI * F0 * h * t) / h
	return 0.3 * v
}

/** Run the library's real transposer over `seconds` of the sawtooth, fed in `chunk`-frame blocks. */
function transpose(strategy: string, rate: number, chunk: number, seconds = 0.5): number[] {
	const tr = new RateTransposer({ createBuffers: true, interpolationStrategy: strategy })
	tr.rate = rate
	const total = SR * seconds
	const out: number[] = []
	for (let n = 0; n < total; n += chunk) {
		const len = Math.min(chunk, total - n)
		const buf = new Float32Array(len * 2)
		for (let i = 0; i < len; i++) buf[2 * i] = buf[2 * i + 1] = saw((n + i) / SR)
		tr.inputBuffer!.putSamples(buf, 0, len)
		tr.process()
		const ob = tr.outputBuffer!
		const k = ob.frameCount
		const o = new Float32Array(k * 2)
		ob.extract(o, 0, k)
		ob.receive(k)
		for (let i = 0; i < k; i++) out.push(o[2 * i])
	}
	return out
}

/**
 * Signal-to-error ratio, in dB, of the audible band against the exact answer: the
 * sawtooth resampled at the transposer's positions (it starts at -1 and steps by
 * `rate`), minus every harmonic shifted past 20 kHz. Both sides go through the same
 * 20 kHz low-pass, so what's left is aliasing and interpolation error that can be
 * heard — not content above hearing that a filter may legitimately keep or drop.
 */
function audibleSnr(out: number[], rate: number): number {
	const taps = 63
	const fc = AUDIBLE / SR
	const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
	const h = Array.from({ length: taps }, (_, i) => {
		const d = i - (taps - 1) / 2
		const blackman =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
			0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
		return 2 * fc * sinc(2 * fc * d) * blackman
	})
	const ideal = out.map((_, j) => saw((j * rate - 1) / SR, (f) => f * rate < AUDIBLE))
	let signal = 0
	let error = 0
	for (let j = 2000; j < out.length - 2000; j++) {
		let got = 0
		let want = 0
		for (let i = 0; i < taps; i++) {
			const jj = j - (taps - 1) / 2 + i
			got += h[i] * out[jj]
			want += h[i] * ideal[jj]
		}
		signal += want * want
		error += (got - want) ** 2
	}
	return 10 * Math.log10(signal / error)
}

const semitones = (n: number) => 2 ** (n / 12)
/** About one WSOLA window: the block size the transposer sees when shifting up. */
const WINDOW = Math.round(SR * 0.11)

describe('bandlimitedKernel', () => {
	it('removes the aliasing the stock kernel lets into the audible band when shifting up', () => {
		const rate = semitones(12)
		expect(audibleSnr(transpose('lanczos', rate, WINDOW), rate)).toBeLessThan(30)
		expect(audibleSnr(transpose(BANDLIMITED_STRATEGY_ID, rate, WINDOW), rate)).toBeGreaterThan(38)
	})

	it.each([-7, -4, 2, 5, 7, 12])('stays accurate at %i semitones, in window-sized blocks', (n) => {
		const rate = semitones(n)
		expect(audibleSnr(transpose(BANDLIMITED_STRATEGY_ID, rate, WINDOW), rate)).toBeGreaterThan(38)
	})

	it.each([-7, -4, 2])('stays accurate at %i semitones, in render-quantum blocks', (n) => {
		// Shifting down (and, through tempo, some shifts up) runs the transposer first,
		// on 128-frame blocks: many more block edges, each with one sample of history.
		const rate = semitones(n)
		expect(audibleSnr(transpose(BANDLIMITED_STRATEGY_ID, rate, 128), rate)).toBeGreaterThan(38)
	})

	it('lowers the cutoff below the output Nyquist only when decimating', () => {
		expect(cutoffFor(0.5)).toBe(1)
		expect(cutoffFor(2)).toBeCloseTo(0.46)
		expect(cutoffFor(semitones(5))).toBeLessThan(1 / semitones(5))
	})
})
