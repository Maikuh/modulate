/**
 * The Signalsmith Stretch worklet (`signalsmith-stretch`, MIT): a phase-vocoder
 * pitch shifter, compiled to WASM, run in an AudioWorklet.
 *
 * Not the package's own main-thread factory: that one bundles the whole WASM
 * build (114 KB) into whatever imports it — here the MAIN-world script — and loads
 * the worklet from a Blob URL, which YouTube's CSP refuses. The worklet file
 * self-registers wherever it is evaluated as a worklet module, so we ship it as a
 * web-accessible file (`modules/signalsmith-processor.ts`) and speak its port
 * protocol directly: `[id, method, ...args]` out, `[id, result]` back, and
 * `['ready', …]` once the WASM has instantiated.
 *
 * Side-effect-free and free of extension APIs: imported by the MAIN-world bundle.
 */

/** Name the worklet module registers its processor under. */
export const PROCESSOR_NAME = 'signalsmith-stretch'

/**
 * STFT block and hop. A longer block resolves close partials (chords, full mixes)
 * more cleanly but delays the audio more; 120 ms measured ~33 dB cleaner than
 * SoundTouch on a triad, against ~26 dB at 90 ms for ~35 ms less delay.
 * `splitComputation` spreads each block's FFT work evenly over the render quanta
 * in between — ~30 ms more delay, but the worst quantum costs ~5× less, and
 * per-quantum spikes are what miss Firefox's worklet deadline and crackle.
 */
export const STRETCH_CONFIG = Object.freeze({
	blockMs: 120,
	intervalMs: 30,
	splitComputation: true,
})

/**
 * The shift to ask the worklet for. In live-input mode it ignores any rate, and
 * the element plays raw at `tempo` — pitch scaled like a record — so the shift
 * also undoes that.
 */
export function stretchSemitones(semitones: number, tempo: number): number {
	return semitones - 12 * Math.log2(tempo)
}

/**
 * A safety limiter on the processed path. Re-synthesizing changes the phase
 * relationships between partials, which leaves loudness alone but can raise the
 * peaks (up to ~2× on a sawtooth), and a loud master would then clip at the
 * output. Hard and fast just under full scale, so it only ever touches peaks.
 */
const LIMITER = Object.freeze({ threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.1 })

/**
 * The compressor's automatic makeup gain (per the Web Audio spec: the inverse of
 * its gain at full scale, to the power 0.6) would lift everything below the
 * threshold by ~0.6 dB, so the processed path would play louder than the bypass.
 * This cancels it.
 */
export const LIMITER_TRIM = (() => {
	const fullScaleDb = LIMITER.threshold + (0 - LIMITER.threshold) / LIMITER.ratio
	const fullScaleGain = 10 ** (fullScaleDb / 20)
	return fullScaleGain ** 0.6
})()

export interface StretchNode {
	/** Connect the source here. */
	readonly input: AudioWorkletNode
	/** Connect this to the destination. */
	readonly output: AudioNode
	/** Transpose by `semitones` while the element plays raw at `tempo`. */
	set(semitones: number, tempo: number): void
	/**
	 * Whether to process. An inactive worklet outputs silence, so it is active
	 * exactly while it is in the path — and costs nothing while bypassed.
	 */
	setActive(active: boolean): void
}

/**
 * How long the worklet gets to instantiate its WASM and answer its first calls.
 * That takes tens of milliseconds normally; the bound only exists so a worklet
 * that never starts fails the build instead of hanging it.
 */
export const START_TIMEOUT_MS = 10_000

/** Load the worklet module from `moduleUrl` (once per context) and build a node. */
export async function createStretchNode(
	ctx: BaseAudioContext,
	moduleUrl: string,
): Promise<StretchNode> {
	await ctx.audioWorklet.addModule(moduleUrl)
	// Fixed stereo. signalsmith-stretch 1.3.2 handles a channel-count change with a
	// bare `configure()` call that throws inside the processor, so never let the
	// count change: mono sources are up-mixed on the way in.
	const input = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		channelCount: 2,
		channelCountMode: 'explicit',
	})

	const pending = new Map<number, (value: unknown) => void>()
	let nextId = 0
	const ready = new Promise<void>((resolve) => {
		input.port.onmessage = (event: MessageEvent<unknown[]>) => {
			const [id, value] = event.data
			if (id === 'ready') resolve()
			else if (typeof id === 'number') {
				pending.get(id)?.(value)
				pending.delete(id)
			}
		}
	})
	const call = (method: string, ...args: unknown[]) =>
		new Promise<unknown>((resolve) => {
			const id = nextId++
			pending.set(id, resolve)
			input.port.postMessage([id, method, ...args])
		})

	// Bounded: a worklet whose WASM never instantiates (a CSP that stops allowing
	// it, a processor that throws while starting) never posts `ready` nor answers a
	// call, and the build awaiting this would hold the page's apply worker — and
	// every apply queued behind it — forever, with nothing reported. Reject instead,
	// so the build closes the context and the page reports an engine error.
	let timer: ReturnType<typeof setTimeout> | undefined
	let onError: (() => void) | undefined
	const failed = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('the stretch worklet did not start in time')),
			START_TIMEOUT_MS,
		)
		onError = () => reject(new Error('the stretch worklet failed while starting'))
		input.addEventListener('processorerror', onError)
	})
	try {
		const latency = await Promise.race([
			(async () => {
				await ready
				await call('configure', { ...STRETCH_CONFIG })
				return call('latency')
			})(),
			failed,
		])
		console.debug('[modulate] stretch latency (s)', latency)
	} finally {
		clearTimeout(timer)
		input.removeEventListener('processorerror', onError!)
	}

	const limiter = ctx.createDynamicsCompressor()
	limiter.threshold.value = LIMITER.threshold
	limiter.knee.value = LIMITER.knee
	limiter.ratio.value = LIMITER.ratio
	limiter.attack.value = LIMITER.attack
	limiter.release.value = LIMITER.release
	const trim = ctx.createGain()
	trim.gain.value = LIMITER_TRIM
	input.connect(limiter).connect(trim)

	let active = false
	return {
		input,
		output: trim,
		set(semitones, tempo) {
			void call('schedule', { semitones: stretchSemitones(semitones, tempo) })
		},
		setActive(on) {
			if (on === active) return
			active = on
			void call('schedule', { active: on })
		},
	}
}
