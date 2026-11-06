import { FifoSampleBuffer, RateTransposer, Stretch } from '@soundtouchjs/core'
import type { SoundTouch } from '@soundtouchjs/core'

/**
 * How far ahead of steady demand the transposer may run when catching up on a
 * stretch burst, per render quantum. 2× drains a burst in half a window — before
 * the next one arrives — while capping each quantum's work at twice the average.
 */
const PACE = 2

/**
 * The SoundTouch pipeline (same stages, same order as the library's `SoundTouch`),
 * with the rate transposer's work spread evenly across render quanta.
 *
 * Going up (`rate > 1`) SoundTouch stretches first and transposes after. The
 * stretch emits a whole WSOLA window (~100 ms of audio) at a time, and the stock
 * pipeline hands all of it to the transposer at once — so once per window, ~10
 * times a second, one render quantum converts thousands of frames. Chrome's worklet
 * absorbs that; Firefox's misses the render deadline on it, and each miss is an
 * audible crack. Here the stretch's output goes into a holding buffer instead, and
 * each quantum feeds the transposer at most `PACE`× what the steady state needs.
 * `OutputCushion` keeps enough output buffered that the output only has to keep up
 * on average, which pacing guarantees: from the moment a burst lands the transposer
 * outputs faster than the speakers drain, so the output never dips lower than it
 * would have.
 *
 * Going down the order is transposer-first, which already converts each 128-frame
 * block as it arrives; that path is left as the library has it.
 *
 * Why not simply always transpose first: it makes the stretch work on input sped up
 * by `rate`, so its millisecond-sized windows would span `rate`× more of the song —
 * doubling the A/V delay at +12 — and correcting that by telling the stretch a lower
 * sample rate makes every downward pitch change stall for 20–60 ms while the longer
 * windows refill. Keeping the library's order keeps its latency and transitions.
 *
 * It implements only the slice of `SoundTouch` that `SoundTouchProcessorBase` uses,
 * from the package's public building blocks; `SoundTouch` itself keeps its buffers
 * private.
 */
export class PacedPipe implements Pick<
	SoundTouch,
	| 'pitch'
	| 'inputBuffer'
	| 'outputBuffer'
	| 'process'
	| 'setStretchParameters'
	| 'setInterpolationStrategy'
	| 'setInterpolationStrategyParams'
> {
	// FIFO throughout: the stretch's default input adapter silently drops leftover
	// frames from any other buffer type, and the transposer's accepts either.
	readonly inputBuffer = new FifoSampleBuffer()
	readonly outputBuffer = new FifoSampleBuffer()
	/** Between the two stages: stretch output going up, transposer output going down. */
	private readonly intermediate = new FifoSampleBuffer()
	/** Going up: what the transposer converts this quantum, metered from `intermediate`. */
	private readonly metered = new FifoSampleBuffer()
	private readonly transposer: RateTransposer
	private readonly stretch: Stretch
	/** Output level below which pacing yields to refilling, in frames. */
	private readonly lowWater: number
	private rate = Number.NaN
	/** Whether the stages are wired stretch-first (rate > 1). */
	private stretchFirst = false
	/** `inputBuffer` level left after the last `process`, to count each quantum's input. */
	private inputLeft = 0
	private scratch = new Float32Array(0)

	/**
	 * @param lowWater Output frames to keep ready regardless of pacing. Set it just
	 *   above what the consumer holds back (`OutputCushion`'s hold plus a quantum), so
	 *   refilling only kicks in when the output is genuinely about to run dry.
	 */
	constructor(sampleRate: number, interpolationStrategy: string, lowWater: number) {
		this.lowWater = lowWater
		this.transposer = new RateTransposer({ interpolationStrategy })
		this.stretch = new Stretch({ sampleRate })
		// Zeros: tempo-adaptive window lengths (see `lib/audioQuality.ts` for why they
		// must stay automatic).
		this.stretch.setParameters(sampleRate, 0, 0, 0)
		this.wire(false)
		this.pitch = 1
	}

	/**
	 * The pitch ratio, set every render quantum: transposer `rate = pitch`, stretch
	 * `tempo = 1 / pitch`, as in `SoundTouch`.
	 */
	set pitch(pitch: number) {
		// Guarded: the stretch's tempo setter resets its fractional skip accumulator,
		// which must not happen on every quantum.
		if (pitch === this.rate) return
		const stretchFirst = pitch > 1
		if (stretchFirst !== this.stretchFirst) {
			if (this.stretchFirst) {
				// Leaving the stretch-first order: anything still metered or waiting was
				// already stretched for the old ratio, so convert it now at the old rate
				// rather than strand it in a buffer the new wiring never reads.
				this.drainUnpaced()
			} else {
				// Entering it: what waits between the stages was transposed but not yet
				// stretched. Hand it to the stretch, as `SoundTouch` effectively does (its
				// stretch adapter keeps its own copy across the rewire). Sent through the
				// transposer again instead, it would leave the stretch to fill a whole
				// window from nothing — 20–50 ms of silence on every upward change.
				// `inputBuffer` is empty here: the transposer drains it every quantum.
				const moved = this.intermediate.frameCount
				this.move(this.intermediate, this.inputBuffer, moved)
				this.inputLeft += moved
			}
			this.wire(stretchFirst)
		}
		this.rate = pitch
		this.transposer.rate = pitch
		this.stretch.tempo = 1 / pitch
	}

	process(): void {
		const added = this.inputBuffer.frameCount - this.inputLeft
		if (this.stretchFirst) {
			this.stretch.process()
			// The stretch emits `rate` frames per input frame on average; let the
			// transposer take up to PACE times that — unless the output is running low
			// (startup, or a pitch change making the stretch refill a window), where
			// pacing would starve it: then convert enough to bring it back up at once.
			const paced = PACE * added * this.rate
			const refill = (this.lowWater - this.outputBuffer.frameCount) * this.rate
			this.meter(Math.ceil(Math.max(paced, refill)))
			this.transposer.process()
		} else {
			this.transposer.process()
			this.stretch.process()
		}
		this.inputLeft = this.inputBuffer.frameCount
	}

	setStretchParameters(params: Parameters<SoundTouch['setStretchParameters']>[0]): void {
		this.stretch.setStretchParameters(params)
	}

	setInterpolationStrategy(strategy: Parameters<SoundTouch['setInterpolationStrategy']>[0]): void {
		this.transposer.setInterpolationStrategy(strategy)
	}

	setInterpolationStrategyParams(
		params: Parameters<SoundTouch['setInterpolationStrategyParams']>[0],
	): void {
		this.transposer.setInterpolationStrategyParams(params)
	}

	private wire(stretchFirst: boolean): void {
		this.stretchFirst = stretchFirst
		if (stretchFirst) {
			this.stretch.inputBuffer = this.inputBuffer
			this.stretch.outputBuffer = this.intermediate
			this.transposer.inputBuffer = this.metered
			this.transposer.outputBuffer = this.outputBuffer
		} else {
			this.transposer.inputBuffer = this.inputBuffer
			this.transposer.outputBuffer = this.intermediate
			this.stretch.inputBuffer = this.intermediate
			this.stretch.outputBuffer = this.outputBuffer
		}
	}

	/** Move up to `frames` frames from `intermediate` into `metered`. */
	private meter(frames: number): void {
		this.move(this.intermediate, this.metered, frames)
	}

	private move(from: FifoSampleBuffer, to: FifoSampleBuffer, frames: number): void {
		const n = Math.min(frames, from.frameCount)
		if (n <= 0) return
		if (this.scratch.length < n * 2) this.scratch = new Float32Array(n * 2)
		from.extract(this.scratch, 0, n)
		from.receive(n)
		to.putSamples(this.scratch, 0, n)
	}

	/** Convert everything the stretch has produced, in one go (only on a rewire). */
	private drainUnpaced(): void {
		this.meter(this.intermediate.frameCount)
		this.transposer.process()
	}
}
