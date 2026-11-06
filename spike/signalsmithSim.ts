/**
 * SPIKE — offline driver for the real `signalsmith-stretch` AudioWorklet
 * processor. Its module self-registers when evaluated where
 * `AudioWorkletProcessor` and `registerProcessor` exist, so stubbing those (plus
 * `sampleRate`/`currentTime`) and importing it hands us the actual processor class
 * — WASM and all — to drive one 128-frame quantum at a time, like a browser would.
 */

export const SR = 48_000
export const QUANTUM = 128

type Port = {
	postMessage(msg: unknown): void
	onmessage: ((e: { data: unknown[] }) => void) | null
}
type Processor = {
	port: Port
	process(inputs: Float32Array[][], outputs: Float32Array[][], params: object): boolean
}
type ProcessorClass = new (options: object) => Processor

const g = globalThis as Record<string, unknown>
let Registered: ProcessorClass | undefined
const outbox: unknown[][] = []

g.sampleRate = SR
g.currentTime = 0
g.AudioWorkletProcessor = class {
	port: Port = { postMessage: (msg) => outbox.push(msg as unknown[]), onmessage: null }
}
g.registerProcessor = (_name: string, cls: ProcessorClass) => {
	Registered = cls
}
await import('signalsmith-stretch')
if (!Registered) throw new Error('signalsmith-stretch did not register a processor')
const ProcessorCtor: ProcessorClass = Registered

export interface StretchConfig {
	preset?: 'default' | 'cheaper'
	blockMs?: number
	intervalMs?: number
	splitComputation?: boolean
}

/** A live-input Signalsmith processor, configured and started. */
export async function createStretch(config: StretchConfig, semitones: number) {
	g.currentTime = 0
	const proc = new ProcessorCtor({ numberOfOutputs: 1, outputChannelCount: [2] })
	// The WASM instantiates asynchronously; wait for the processor's 'ready'.
	for (let i = 0; i < 200 && !outbox.some((m) => m[0] === 'ready'); i++) {
		await new Promise((r) => setTimeout(r, 5))
	}
	if (!outbox.some((m) => m[0] === 'ready')) throw new Error('WASM never became ready')
	outbox.length = 0
	let id = 0
	const call = (method: string, ...args: unknown[]) => {
		proc.port.onmessage!({ data: [id++, method, ...args] })
		const reply = outbox.find((m) => m[0] === id - 1)
		return reply?.[1]
	}
	if (config.blockMs || config.preset) call('configure', config)
	call('schedule', { active: true, semitones })
	const latency = call('latency') as number

	const outL = new Float32Array(QUANTUM)
	const outR = new Float32Array(QUANTUM)
	let time = 0
	return {
		latency,
		setSemitones: (st: number) => call('schedule', { semitones: st }),
		process(inL: Float32Array, inR: Float32Array): [Float32Array, Float32Array] {
			g.currentTime = time
			proc.process([[inL, inR]], [[outL, outR]], {})
			time += QUANTUM / SR
			return [outL, outR]
		},
	}
}
