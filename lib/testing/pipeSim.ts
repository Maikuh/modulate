import { registerInterpolationStrategy, SoundTouch } from '@soundtouchjs/core'

import { BANDLIMITED_STRATEGY_ID, bandlimitedKernel } from '@/lib/bandlimitedKernel'
import { CUSHION_SECONDS, OutputCushion } from '@/lib/outputCushion'
import { PacedPipe } from '@/lib/pacedPipe'

/**
 * Offline model of `entrypoints/soundtouch-processor.ts`, for specs: the same
 * pipe, cushion and kernel, driven one 128-frame render quantum at a time the way
 * the AudioWorklet drives them. Test-only; nothing in the extension imports it.
 *
 * It models the DSP, not the browser: no render-deadline misses, no output
 * latency of the context itself. What it can measure is what our code controls —
 * whether the output FIFO ever runs dry once playing, how much work a quantum
 * does, and how far the output trails the input.
 */

registerInterpolationStrategy({ id: BANDLIMITED_STRATEGY_ID, kernel: bandlimitedKernel })

export const SR = 48_000
export const QUANTUM = 128
/** As the processor configures them: the cushion, and low water a quantum above it. */
export const HOLD = Math.round(SR * CUSHION_SECONDS)
export const LOW_WATER = HOLD + QUANTUM

export type Pipe = Pick<SoundTouch, 'inputBuffer' | 'outputBuffer' | 'process'> & {
	pitch: number
}

export const pacedPipe = (): Pipe => new PacedPipe(SR, BANDLIMITED_STRATEGY_ID, LOW_WATER)
export const stockPipe = (): Pipe =>
	new SoundTouch({ sampleRate: SR, interpolationStrategy: BANDLIMITED_STRATEGY_ID })

export const semitoneRatio = (n: number) => 2 ** (n / 12)

/**
 * The pipe's pitch for a setting, as `SoundTouchProcessorBase` computes it: the
 * element plays raw at `tempo` (pitch scaled by it), and the worklet divides that
 * back out on top of the transpose.
 */
export const pipePitch = (semitones: number, tempo: number) => semitoneRatio(semitones) / tempo

export interface DriveResult {
	/** Left channel of everything played, one entry per output frame. */
	out: number[]
	/** Output frames each quantum produced (its work). */
	produced: number[]
	/** Frames each quantum played once playback had started (short = silence). */
	played: number[]
	/** Quantum index at which playback started. */
	startedAt: number
	/** Total frames played (not zero-filled). */
	playedFrames: number
}

/**
 * Drive `pipe` for `seconds` of real time: set the pitch, push one quantum of
 * `input(t)` (t in frames), process, and play what `OutputCushion` allows.
 */
export function drive(
	pipe: Pipe,
	pitchAt: (seconds: number) => number,
	seconds: number,
	input: (frame: number) => number = sine(330),
): DriveResult {
	const cushion = new OutputCushion(HOLD)
	const out: number[] = []
	const produced: number[] = []
	const played: number[] = []
	let startedAt = -1
	let playedFrames = 0
	const block = new Float32Array(QUANTUM * 2)
	let t = 0
	const quanta = Math.round((SR * seconds) / QUANTUM)
	for (let b = 0; b < quanta; b++) {
		pipe.pitch = pitchAt((b * QUANTUM) / SR)
		for (let i = 0; i < QUANTUM; i++, t++) block[2 * i] = block[2 * i + 1] = input(t)
		const before = pipe.outputBuffer.frameCount
		pipe.inputBuffer.putSamples(block, 0, QUANTUM)
		pipe.process()
		const level = pipe.outputBuffer.frameCount
		produced.push(level - before)
		const k = cushion.take(level, QUANTUM)
		playedFrames += k
		if (startedAt >= 0) played.push(k)
		else if (k > 0) startedAt = b
		const o = new Float32Array(k * 2)
		pipe.outputBuffer.extract(o, 0, k)
		pipe.outputBuffer.receive(k)
		// Zero-fill like the processor does, so `out` stays on the real-time clock.
		for (let i = 0; i < QUANTUM; i++) out.push(i < k ? o[2 * i]! : 0)
	}
	return { out, produced, played, startedAt, playedFrames }
}

export const sine =
	(freq: number, amplitude = 0.5) =>
	(t: number) =>
		amplitude * Math.sin((2 * Math.PI * freq * t) / SR)

/** Silence until `onsetFrame`, then `signal`. */
export const onset =
	(onsetFrame: number, signal: (t: number) => number = sine(330)) =>
	(t: number) =>
		t < onsetFrame ? 0 : signal(t)

/** First frame at or after `from` whose magnitude reaches `threshold`, or -1. */
export function firstAbove(signal: number[], threshold: number, from = 0): number {
	for (let i = from; i < signal.length; i++) if (Math.abs(signal[i]!) >= threshold) return i
	return -1
}
