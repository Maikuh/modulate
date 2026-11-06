/**
 * How much slack the worklet keeps in its output FIFO. 20 ms is a few render quanta
 * — enough to absorb the rounding the pipeline drifts by and the transient after a
 * pitch/tempo change (measured offline across ±12 semitones × 0.5–2× tempo), and
 * small next to the window of input the WSOLA stage already buffers before it can
 * emit anything (~100 ms+), so it adds no audible A/V offset.
 */
export const CUSHION_SECONDS = 0.02

/**
 * Decides how many frames the SoundTouch worklet hands to the speakers each render
 * quantum, so its output FIFO never runs dry mid-stream.
 *
 * The stock processor outputs whatever is available, up to a quantum, and zero-fills
 * the rest. That starts playback the instant the pipeline produces anything, so the
 * FIFO hugs empty from then on: WSOLA emits a whole window at a time and the stream
 * drains exactly as fast as it fills, so the level falls back to ~0 before every
 * window, and fractional rounding periodically leaves it a frame or two short. Each
 * shortfall is zeros spliced into the waveform — an audible click. It happens
 * whenever the effective pitch ratio is above 1 (transposing up, or slowing down),
 * where the stretch stage runs first and its bursts reach the output unsmoothed;
 * transposing down goes through the transposer first and fills evenly.
 *
 * The fix is to start (and, after a dry spell, restart) playback a fixed time
 * AFTER the first output appears, not the moment it does. Production is unaffected
 * by when consumption starts, so the FIFO then bottoms out at roughly that hold
 * instead of at zero. Counting time, not level, matters: a level threshold can be
 * crossed by a single burst, which leaves no slack at all once the burst drains.
 */
export class OutputCushion {
	private remaining: number
	private primed = false

	constructor(private readonly holdFrames: number) {
		this.remaining = holdFrames
	}

	/**
	 * How many of the `available` frames to play in a quantum of `frameCount`; the
	 * caller zero-fills the rest.
	 */
	take(available: number, frameCount: number): number {
		if (!this.primed) {
			// Start the clock only once the pipeline produces: before that the stretch
			// stage is still filling its first window, and waiting through it adds
			// latency without adding slack.
			if (available > 0) this.remaining -= frameCount
			if (this.remaining > 0) return 0
			this.primed = true
		}
		if (available < frameCount) {
			// Ran dry anyway (a seek or a big parameter jump can reshape the bursts):
			// play what is left, then rebuild the cushion rather than limp along at empty,
			// clicking on every window from here on.
			this.primed = false
			this.remaining = this.holdFrames
		}
		return Math.min(available, frameCount)
	}
}
