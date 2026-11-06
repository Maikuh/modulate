/**
 * Offline harness for the real Signalsmith Stretch worklet processor — WASM and
 * all. Its module self-registers when evaluated where `AudioWorkletProcessor` and
 * `registerProcessor` exist, so stubbing those (plus `sampleRate`/`currentTime`)
 * and importing it hands us the processor class to drive one render quantum at a
 * time, the way a browser would. Test-only; nothing in the extension imports it.
 *
 * Import it from specs running in the node environment: under happy-dom the
 * emscripten loader takes its browser path.
 */

export const SR = 48_000
export const QUANTUM = 128

type PortMessage = { data: unknown[] }
interface Port {
	postMessage(msg: unknown[]): void
	onmessage: ((e: PortMessage) => void) | null
}
export interface Processor {
	port: Port
	config: Record<string, unknown>
	timeMap: Array<{ active: boolean; semitones: number }>
	process(inputs: Float32Array[][], outputs: Float32Array[][], params: object): boolean
}
type ProcessorClass = new (options: object) => Processor

const g = globalThis as Record<string, unknown>
let Registered: ProcessorClass | undefined
/** Where the next constructed processor's outgoing messages go. */
let nextOutbox: (msg: unknown[]) => void = () => {}

g.sampleRate = SR
g.currentTime = 0
g.AudioWorkletProcessor = class {
	port: Port = { postMessage: (msg) => nextOutbox(msg), onmessage: null }
}
g.registerProcessor = (_name: string, cls: ProcessorClass) => {
	Registered = cls
}
await import('signalsmith-stretch')
if (!Registered) throw new Error('signalsmith-stretch did not register a processor')
const ProcessorCtor: ProcessorClass = Registered

/** Construct a processor whose outgoing port messages go to `onMessage`. */
export function constructProcessor(
	options: object,
	onMessage: (msg: unknown[]) => void,
): Processor {
	nextOutbox = onMessage
	return new ProcessorCtor(options)
}

/**
 * A processor driven synchronously: configured, started at `semitones`, ready to
 * `process` quanta. Resolves once its WASM has instantiated.
 */
export async function liveProcessor(config: object, semitones: number) {
	g.currentTime = 0
	const inbox: unknown[][] = []
	const proc = constructProcessor({ numberOfOutputs: 1, outputChannelCount: [2] }, (m) =>
		inbox.push(m),
	)
	await until(() => inbox.some((m) => m[0] === 'ready'))
	let id = 0
	const call = (method: string, ...args: unknown[]) => {
		const mine = id++
		proc.port.onmessage!({ data: [mine, method, ...args] })
		return inbox.find((m) => m[0] === mine)?.[1]
	}
	call('configure', config)
	call('schedule', { active: true, semitones })
	const latency = call('latency') as number

	const outL = new Float32Array(QUANTUM)
	const outR = new Float32Array(QUANTUM)
	let time = 0
	return {
		latency,
		process(inL: Float32Array, inR: Float32Array): Float32Array {
			g.currentTime = time
			proc.process([[inL, inR]], [[outL, outR]], {})
			time += QUANTUM / SR
			return outL
		},
	}
}

/** Poll `done` on the macrotask queue (the WASM instantiates asynchronously). */
export async function until(done: () => boolean, tries = 400): Promise<void> {
	for (let i = 0; i < tries && !done(); i++) await new Promise((r) => setTimeout(r, 5))
	if (!done()) throw new Error('timed out')
}
