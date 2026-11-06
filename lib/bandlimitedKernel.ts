import type { InterpolationStrategyRegistration } from '@soundtouchjs/core'

/** The kernel contract (the package doesn't export its own name for it). */
type InterpolationKernel = NonNullable<InterpolationStrategyRegistration['kernel']>

/**
 * A replacement for SoundTouch's stock Lanczos interpolation kernel: band-limited,
 * and table-driven.
 *
 * The rate transposer resamples by `rate` (the effective pitch ratio). Going up
 * (`rate > 1`) it decimates, and the stock kernel is a fixed 8-tap Lanczos with its
 * cutoff at the input's Nyquist — so everything the shift pushes past the output's
 * Nyquist folds back down as inharmonic grit (from about +7 semitones it lands in
 * the audible band; at +12 the signal-to-error ratio is ~25 dB). This kernel lowers
 * its cutoff to `BANDWIDTH / rate` and widens itself by the same factor, which is
 * what a correct decimator does.
 *
 * It is also several times cheaper per sample: the stock kernel evaluates two
 * `Math.sin` per tap per channel, while this one reads its weights from a table.
 * (Under the stock stage order that alone cut the per-window CPU spike that cracks
 * on Firefox by ~3×; `PacedPipe` spreads out what is left of it.)
 *
 * Kernels aren't told the rate, so it is inferred: the transposer calls the kernel
 * at positions exactly `rate` apart (channel 0 then channel 1 at each position), so
 * the gap between consecutive channel-0 positions is the rate. A block boundary
 * rewinds the position (it becomes relative to the next block), which reads as a
 * negative gap and is skipped, keeping the previous estimate.
 *
 * Like the stock kernel, it sees only one sample of history across a block boundary
 * (`prevSampleL/R`, maintained by the transposer) and clamps reads past the block's
 * end — a limitation of the kernel interface, measured as negligible (~60 dB down).
 */

/** Strategy id the processor registers this kernel under. */
export const BANDLIMITED_STRATEGY_ID = 'modulate-bandlimited'

/** Lobes of the Lanczos window on each side, as in the stock kernel. */
const ZERO_CROSSINGS = 4
/**
 * Cutoff as a fraction of the output's Nyquist. A little under 1 leaves room for
 * the window's transition band, so it finishes rolling off before frequencies fold.
 * At 48 kHz that puts the cutoff around 22 kHz — above hearing.
 */
const BANDWIDTH = 0.92
/** Table entries per zero crossing; weights between entries are interpolated. */
const RESOLUTION = 512
/** Largest rate the gap inference accepts (the worklet's `pitch` param max). */
const MAX_RATE = 8

function sinc(x: number): number {
	if (x === 0) return 1
	const px = Math.PI * x
	return Math.sin(px) / px
}

/** The Lanczos window `sinc(u) * sinc(u / a)` for `u` in [0, ZERO_CROSSINGS]. */
const TABLE = new Float32Array(ZERO_CROSSINGS * RESOLUTION + 2)
for (let i = 0; i < TABLE.length; i++) {
	const u = i / RESOLUTION
	TABLE[i] = u < ZERO_CROSSINGS ? sinc(u) * sinc(u / ZERO_CROSSINGS) : 0
}

function weight(u: number): number {
	const f = Math.abs(u) * RESOLUTION
	const i = Math.floor(f)
	if (i >= ZERO_CROSSINGS * RESOLUTION) return 0
	return TABLE[i]! + (TABLE[i + 1]! - TABLE[i]!) * (f - i)
}

export interface BandlimitedState {
	/** Last frame of the previous block, written by the transposer. */
	prevSampleL: number
	prevSampleR: number
	/** Cutoff relative to the input's Nyquist: `min(1, BANDWIDTH / rate)`. */
	cutoff: number
	/** Channel-0 position of the previous call, for inferring the rate. */
	lastPosition: number
}

/** The cutoff for a resampling rate. */
export function cutoffFor(rate: number): number {
	return Math.min(1, BANDWIDTH / rate)
}

function kernel(
	src: Float32Array,
	srcOffset: number,
	numFrames: number,
	position: number,
	channel: 0 | 1,
	rawState: unknown,
): number {
	const state = rawState as BandlimitedState
	if (channel === 0) {
		const gap = position - state.lastPosition
		if (gap > 0 && gap <= MAX_RATE) state.cutoff = cutoffFor(gap)
		state.lastPosition = position
	}

	const cutoff = state.cutoff
	// The kernel spans ZERO_CROSSINGS lobes of the cutoff frequency, so it widens as
	// the cutoff drops.
	const radius = ZERO_CROSSINGS / cutoff
	const first = Math.ceil(position - radius)
	const last = Math.floor(position + radius)
	const prev = channel === 0 ? state.prevSampleL : state.prevSampleR
	const lastFrame = srcOffset + 2 * (numFrames - 1) + channel

	let sum = 0
	let norm = 0
	for (let k = first; k <= last; k++) {
		const w = weight((position - k) * cutoff)
		if (w === 0) continue
		const x = k < 0 ? prev : k >= numFrames ? src[lastFrame]! : src[srcOffset + 2 * k + channel]!
		sum += x * w
		norm += w
	}
	// Normalizing by the weight sum keeps unity gain at every fractional position
	// (and folds in the cutoff's 1/rate amplitude scale).
	return norm === 0 ? 0 : sum / norm
}

export const bandlimitedKernel: InterpolationKernel = Object.assign(kernel, {
	createState: (): BandlimitedState => ({
		prevSampleL: 0,
		prevSampleR: 0,
		cutoff: 1,
		lastPosition: Number.POSITIVE_INFINITY,
	}),
})
