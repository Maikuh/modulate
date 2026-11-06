// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	LIMITER_TRIM,
	PROCESSOR_NAME,
	STRETCH_CONFIG,
	createStretchNode,
	stretchSemitones,
} from '@/lib/stretchNode'
import {
	QUANTUM,
	SR,
	constructProcessor,
	liveProcessor,
	until,
	type Processor,
} from '@/lib/testing/stretchSim'

describe('stretchSemitones', () => {
	// The element plays raw at `tempo` (pitch scaled like a record); live input
	// ignores any rate, so the shift has to undo that.
	it('undoes the raw resample on top of the transpose', () => {
		expect(stretchSemitones(5, 1)).toBe(5)
		expect(stretchSemitones(0, 2)).toBeCloseTo(-12)
		expect(stretchSemitones(0, 0.5)).toBeCloseTo(12)
		expect(stretchSemitones(3, 1.5)).toBeCloseTo(3 - 12 * Math.log2(1.5))
	})
})

describe('limiter trim', () => {
	// The compressor's automatic makeup gain is (1 / gain at full scale)^0.6; the
	// trim must cancel it exactly, or the processed path plays louder than the bypass.
	it('cancels the makeup gain', () => {
		const fullScaleDb = -1 + 1 / 20
		const makeup = (1 / 10 ** (fullScaleDb / 20)) ** 0.6
		expect(LIMITER_TRIM * makeup).toBeCloseTo(1, 12)
	})
})

/** Run `seconds` of `input(frame)` through a live processor; returns the output. */
async function render(semitones: number, seconds: number, input: (t: number) => number) {
	const p = await liveProcessor({ ...STRETCH_CONFIG }, semitones)
	const inL = new Float32Array(QUANTUM)
	const out = new Float32Array(Math.round((SR * seconds) / QUANTUM) * QUANTUM)
	let t = 0
	for (let b = 0; b < out.length / QUANTUM; b++) {
		for (let i = 0; i < QUANTUM; i++, t++) inL[i] = input(t)
		out.set(p.process(inL, inL), b * QUANTUM)
	}
	return { out, latency: p.latency }
}

const sine = (freq: number) => (t: number) => 0.3 * Math.sin((2 * Math.PI * freq * t) / SR)

/** Frequency from upward zero crossings over the last second. */
function frequency(out: Float32Array): number {
	const tail = out.subarray(out.length - SR)
	let crossings = 0
	for (let i = 1; i < tail.length; i++) if (tail[i - 1]! < 0 && tail[i]! >= 0) crossings++
	return crossings
}

describe('the Signalsmith worklet, offline', () => {
	// Element at `tempo` feeds the worklet `freq * tempo`; the shift lands on the
	// transposed pitch whatever the tempo.
	it.each([
		[5, 1],
		[-12, 1],
		[12, 1],
		[-5, 0.75],
		[7, 1.5],
		[12, 2],
		[-12, 0.5],
	])('lands on the transposed pitch (%i st at %f×)', async (semitones, tempo) => {
		const { out } = await render(stretchSemitones(semitones, tempo), 3, sine(330 * tempo))
		// Within 1% (a semitone is 6%); zero crossings over 1 s resolve ±1 Hz.
		const ratio = frequency(out) / (330 * 2 ** (semitones / 12))
		expect(Math.abs(ratio - 1)).toBeLessThan(0.01)
	})

	// The video isn't delayed to match, so this is how far audio trails the picture
	// (before the context's own output latency). ~145 ms with the shipped config.
	it('trails its input by the latency it reports, under 160 ms', async () => {
		const onset = SR
		const { out, latency } = await render(5, 2, (t) => (t < onset ? 0 : sine(330)(t)))
		let heard = onset
		while (heard < out.length && Math.abs(out[heard]!) < 0.03) heard++
		const measured = (heard - onset) / SR
		expect(latency).toBeLessThan(0.16)
		expect(Math.abs(measured - latency)).toBeLessThan(0.02)
	})

	it('never drops out once playing', async () => {
		const { out } = await render(7, 3, sine(220))
		for (let b = SR / QUANTUM; b < out.length / QUANTUM; b++) {
			const block = out.subarray(b * QUANTUM, (b + 1) * QUANTUM)
			expect(block.some((x) => x !== 0)).toBe(true)
		}
	})
})

describe('createStretchNode', () => {
	/** The real processor behind a fake AudioWorkletNode, ports linked both ways. */
	let processor: Processor | undefined
	class LinkedWorkletNode {
		readonly port = {
			onmessage: null as ((e: { data: unknown[] }) => void) | null,
			postMessage: (msg: unknown[]) => {
				// Structured-cloned and delivered on a later task, as in a browser.
				const copy = structuredClone(msg)
				setTimeout(() => processor!.port.onmessage?.({ data: copy }))
			},
		}
		readonly options: Record<string, unknown>
		readonly name: string
		constructor(_ctx: unknown, name: string, options: Record<string, unknown>) {
			this.name = name
			this.options = options
			processor = constructProcessor(options, (msg) =>
				setTimeout(() => this.port.onmessage?.({ data: structuredClone(msg) })),
			)
		}
		connect<T>(next: T): T {
			return next
		}
	}

	const param = () => ({ value: 0 })
	const ctx = {
		audioWorklet: { addModule: vi.fn(async () => {}) },
		createDynamicsCompressor: () => ({
			threshold: param(),
			knee: param(),
			ratio: param(),
			attack: param(),
			release: param(),
			connect: <T>(next: T) => next,
		}),
		createGain: () => ({ gain: param(), connect: <T>(next: T) => next }),
	}

	afterEach(() => {
		vi.unstubAllGlobals()
		processor = undefined
	})

	it('loads the module, configures it and drives it over the port', async () => {
		vi.stubGlobal('AudioWorkletNode', LinkedWorkletNode)
		vi.spyOn(console, 'debug').mockImplementation(() => {})

		const node = await createStretchNode(ctx as never, 'chrome-extension://x/processor.js')

		expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('chrome-extension://x/processor.js')
		const worklet = node.input as unknown as LinkedWorkletNode
		expect(worklet.name).toBe(PROCESSOR_NAME)
		// Pinned stereo: a channel-count change hits a throwing path in 1.3.2.
		expect(worklet.options).toMatchObject({ outputChannelCount: [2], channelCountMode: 'explicit' })
		expect(processor!.config).toMatchObject(STRETCH_CONFIG)

		node.set(3, 1.5)
		node.setActive(true)
		await until(() => processor!.timeMap.at(-1)!.active)
		expect(processor!.timeMap.at(-1)!.semitones).toBeCloseTo(stretchSemitones(3, 1.5))

		node.setActive(false)
		await until(() => !processor!.timeMap.at(-1)!.active)
	})
})
