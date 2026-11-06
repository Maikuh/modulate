import { SoundTouchNode } from '@soundtouchjs/audio-worklet'

import type { AudioQuality, EngineKind } from '@/lib/audioQuality'

/**
 * SPIKE — the worklet that does the shifting, behind one interface so the engine
 * can swap SoundTouch for Signalsmith Stretch inside a live context (the element
 * stays captured; only the node between source and destination changes).
 *
 * Both are driven the same way: the element resamples raw at `tempo` (pitch
 * scaled like a record) and the worklet transposes by `semitones` while undoing
 * that rate change.
 */
export interface Shifter {
	readonly kind: EngineKind
	readonly node: AudioWorkletNode
	set(semitones: number, tempo: number): void
	setQuality(quality: AudioQuality): void
	/** Whether the worklet should process (it is pointless while bypassed). */
	setActive(active: boolean): void
}

export async function createShifter(
	kind: EngineKind,
	ctx: AudioContext,
	processorUrl: string,
	quality: AudioQuality,
): Promise<Shifter> {
	return kind === 'signalsmith'
		? createSignalsmith(ctx, signalsmithUrl(processorUrl))
		: createSoundTouch(ctx, processorUrl, quality)
}

/** The Signalsmith worklet module sits next to the SoundTouch one. */
function signalsmithUrl(processorUrl: string): string {
	return new URL('/signalsmith-processor.js', processorUrl).href
}

async function createSoundTouch(
	ctx: AudioContext,
	processorUrl: string,
	quality: AudioQuality,
): Promise<Shifter> {
	await SoundTouchNode.register(ctx, processorUrl)
	const node = new SoundTouchNode({ context: ctx })
	// `quickSeek: false` runs the full cross-correlation search per splice; a wider
	// `overlapMs` lengthens the crossfade between splices. CPU against artifacts.
	const stretch = (q: AudioQuality) =>
		node.setStretchParameters({ overlapMs: q.overlapMs, quickSeek: q.quickSeek })
	stretch(quality)
	return {
		kind: 'soundtouch',
		node,
		set(semitones, tempo) {
			node.pitchSemitones.value = semitones
			node.playbackRate.value = tempo
		},
		setQuality: stretch,
		setActive: () => {},
	}
}

/** Processor name the Signalsmith module registers under. */
const SIGNALSMITH_PROCESSOR = 'signalsmith-stretch'

/**
 * Signalsmith Stretch, without its main-thread factory: that one bundles the whole
 * WASM build (114 KB) into the page and loads the worklet from a Blob URL, which
 * YouTube's CSP refuses. This speaks the processor's port protocol directly —
 * `[id, method, ...args]` out, `[id, result]` back, `['ready', …]` once the WASM
 * has instantiated — and the module loads from our own web-accessible file.
 */
async function createSignalsmith(ctx: AudioContext, moduleUrl: string): Promise<Shifter> {
	await ctx.audioWorklet.addModule(moduleUrl)
	// Fixed stereo out: the processor reconfigures on a channel-count change through
	// a bare `configure()` call that throws (a bug in 1.3.2), so never let it change.
	const node = new AudioWorkletNode(ctx, SIGNALSMITH_PROCESSOR, {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		channelCount: 2,
		channelCountMode: 'explicit',
	})
	const pending = new Map<number, (value: unknown) => void>()
	let nextId = 0
	const ready = new Promise<void>((resolve) => {
		node.port.onmessage = (event: MessageEvent<unknown[]>) => {
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
			node.port.postMessage([id, method, ...args])
		})
	await ready
	// The default preset (120 ms blocks, 30 ms interval) measured cleanest offline;
	// splitting the computation evens each quantum's CPU (p99 ~5x lower) for ~30 ms
	// more latency. See spike/RESULTS.md.
	await call('configure', { blockMs: 120, intervalMs: 30, splitComputation: true })
	console.debug('[modulate] signalsmith latency (s)', await call('latency'))

	let active = false
	return {
		kind: 'signalsmith',
		node,
		set(semitones, tempo) {
			// Live input ignores `rate`; the element's raw resample is undone as pitch.
			void call('schedule', { semitones: semitones - 12 * Math.log2(tempo) })
		},
		setQuality: () => {},
		setActive(on) {
			if (on === active) return
			active = on
			void call('schedule', { active: on })
		},
	}
}
