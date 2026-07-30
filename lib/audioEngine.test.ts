import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * happy-dom implements no Web Audio at all, so the graph gets a hand-rolled fake.
 *
 * It models only what the engine's invariants depend on — who is connected to
 * whom, how many contexts are live, and how many times an element was captured.
 * Those are exactly the properties that mute audio or exhaust the browser's
 * context cap when they regress, and none of them are observable any other way
 * short of loading the extension onto a real page.
 */
class FakeAudioParam {
	value = 0
}

class FakeNode {
	readonly outputs = new Set<FakeNode>()

	connect(target: FakeNode): FakeNode {
		this.outputs.add(target)
		return target
	}

	disconnect(): void {
		this.outputs.clear()
	}

	/** Whether a path exists from here to `target`, however many hops. */
	reaches(target: FakeNode, seen = new Set<FakeNode>()): boolean {
		if (this.outputs.has(target)) return true
		for (const out of this.outputs) {
			if (seen.has(out)) continue
			seen.add(out)
			if (out.reaches(target, seen)) return true
		}
		return false
	}
}

class FakeSoundTouchNode extends FakeNode {
	static register = vi.fn<(ctx: unknown, url: string) => Promise<void>>()
	/** The worklet built for each context, so tests can reach it. */
	static byContext = new WeakMap<FakeAudioContext, FakeSoundTouchNode>()

	pitchSemitones = new FakeAudioParam()
	playbackRate = new FakeAudioParam()
	setStretchParameters = vi.fn()

	constructor(opts: { context: FakeAudioContext }) {
		super()
		FakeSoundTouchNode.byContext.set(opts.context, this)
	}
}

class FakeAudioContext {
	static live = 0
	static created: FakeAudioContext[] = []
	/** Elements captured across ALL contexts — the restriction is per document. */
	static captured = new Set<unknown>()

	state: 'suspended' | 'running' | 'closed' = 'suspended'
	destination = new FakeNode()
	closeCalls = 0
	/** The source node this context handed out, so tests can reach it. */
	source?: FakeNode

	constructor(_opts?: unknown) {
		FakeAudioContext.live++
		FakeAudioContext.created.push(this)
	}

	createMediaElementSource(el: unknown): FakeNode {
		if (FakeAudioContext.captured.has(el)) {
			throw new DOMException('already connected previously', 'InvalidStateError')
		}
		FakeAudioContext.captured.add(el)
		this.source = new FakeNode()
		return this.source
	}

	async resume(): Promise<void> {
		this.state = 'running'
	}

	async close(): Promise<void> {
		this.closeCalls++
		if (this.state !== 'closed') FakeAudioContext.live--
		this.state = 'closed'
	}

	static reset(): void {
		FakeAudioContext.live = 0
		FakeAudioContext.created = []
		FakeAudioContext.captured = new Set()
	}
}

vi.mock('@soundtouchjs/audio-worklet', () => ({ SoundTouchNode: FakeSoundTouchNode }))

const PROCESSOR_URL = 'chrome-extension://abc/soundtouch-processor.js'

/** The engine is a module singleton, so each test needs a fresh module graph. */
async function freshEngine() {
	vi.resetModules()
	const { audioEngine } = await import('@/lib/audioEngine')
	return audioEngine
}

function makeVideo(): HTMLVideoElement {
	const el = document.createElement('video')
	document.body.append(el)
	return el
}

/** The context the engine most recently built on. */
function currentCtx(): FakeAudioContext {
	const ctx = FakeAudioContext.created.at(-1)
	if (!ctx) throw new Error('no context was built')
	return ctx
}

function currentSource(): FakeNode {
	const { source } = currentCtx()
	if (!source) throw new Error('context never captured an element')
	return source
}

function currentWorklet(): FakeSoundTouchNode {
	const node = FakeSoundTouchNode.byContext.get(currentCtx())
	if (!node) throw new Error('no worklet built for this context')
	return node
}

beforeEach(() => {
	FakeAudioContext.reset()
	FakeSoundTouchNode.register = vi.fn<(ctx: unknown, url: string) => Promise<void>>()
	FakeSoundTouchNode.register.mockResolvedValue(undefined)
	vi.stubGlobal('AudioContext', FakeAudioContext)
	document.body.innerHTML = ''
})

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

describe('AudioEngine — routing', () => {
	// The rule AGENTS.md states twice: every path through route() must leave the
	// source with a path to destination. A captured element cannot fall back to
	// direct output, so a stranded source is silence with no recovery.
	it('keeps the source reaching destination while bypassed', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		engine.applySemitones(0)
		engine.applyTempo(1)

		expect(currentSource().reaches(currentCtx().destination)).toBe(true)
	})

	it('routes through the worklet when transposing', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		engine.applySemitones(5)

		const source = currentSource()
		expect(source.reaches(currentCtx().destination)).toBe(true)
		// ...via the worklet, not straight past it.
		expect(source.outputs.has(currentCtx().destination)).toBe(false)
		expect(source.outputs.has(currentWorklet())).toBe(true)
	})

	it('still reaches destination after crossing the bypass boundary both ways', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const source = currentSource()
		const { destination } = currentCtx()

		for (const step of [
			() => engine.applySemitones(4),
			() => engine.applySemitones(0),
			() => engine.applyTempo(1.5),
			() => engine.applyTempo(1),
		]) {
			step()
			expect(source.reaches(destination)).toBe(true)
		}
	})

	// applyLive writes restricted floats. A throw between route()'s disconnect and
	// its reconnect would strand the source and mute the video permanently.
	it('restores the connection when applying a value throws', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		const source = currentSource()

		// Reject the write the way a real HTMLMediaElement does for a bad rate.
		Object.defineProperty(el, 'playbackRate', {
			set() {
				throw new TypeError('non-finite playbackRate')
			},
			get: () => 1,
			configurable: true,
		})

		expect(() => engine.applyTempo(1.5)).toThrow(TypeError)
		expect(source.reaches(currentCtx().destination)).toBe(true)
	})

	it('pushes pitch and tempo into the worklet params', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		engine.applySemitones(-3)
		engine.applyTempo(0.75)

		expect(currentWorklet().pitchSemitones.value).toBe(-3)
		expect(currentWorklet().playbackRate.value).toBe(0.75)
	})
})

describe('AudioEngine — element rate ownership', () => {
	it('disables preservesPitch only when time-stretching', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.applySemitones(5) // pitch only, tempo still 1
		expect(el.preservesPitch).toBe(true)

		engine.applyTempo(1.5)
		expect(el.preservesPitch).toBe(false)
		expect(el.playbackRate).toBe(1.5)
	})

	// Pitch-shift-only must leave YouTube's own speed menu behaving natively.
	// Forcing preservesPitch=false there resamples raw with nothing compensating,
	// so the viewer's chosen speed also shifts pitch.
	it('leaves a page-set playbackRate alone at tempo 1', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.applySemitones(5)
		el.playbackRate = 2 // the viewer picks 2x in the player
		engine.applySemitones(6) // another pitch nudge must not stomp it

		expect(el.playbackRate).toBe(2)
		expect(el.preservesPitch).toBe(true)
	})

	it('resets the rate on bypass only when it was driving it', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.applyTempo(1.5)
		expect(el.playbackRate).toBe(1.5)
		engine.applyTempo(1)
		expect(el.playbackRate).toBe(1) // ours, so we clean it up

		el.playbackRate = 1.75 // now the page's
		engine.applySemitones(3)
		engine.applySemitones(0)
		expect(el.playbackRate).toBe(1.75) // not ours, so left alone
	})

	it('restores native playback on dispose', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.applyTempo(0.5)

		await engine.dispose()

		expect(el.playbackRate).toBe(1)
		expect(el.preservesPitch).toBe(true)
	})
})

describe('AudioEngine — graph lifecycle', () => {
	it('captures each element at most once', async () => {
		const engine = await freshEngine()
		const el = makeVideo()

		await engine.ensureGraph(el, PROCESSOR_URL)
		await engine.ensureGraph(el, PROCESSOR_URL)
		await engine.ensureGraph(el, PROCESSOR_URL)

		expect(FakeAudioContext.created).toHaveLength(1)
		expect(FakeAudioContext.captured.size).toBe(1)
	})

	// YouTube swaps the <video> for ads and the miniplayer. Browsers cap live
	// contexts at ~6; past that `new AudioContext()` throws and audio dies.
	it('closes the previous context when the element is swapped', async () => {
		const engine = await freshEngine()

		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		expect(FakeAudioContext.created).toHaveLength(2)
		expect(FakeAudioContext.created[0].closeCalls).toBe(1)
		expect(FakeAudioContext.live).toBe(1)
	})

	it('does not leak a context across many swaps', async () => {
		const engine = await freshEngine()
		for (let i = 0; i < 10; i++) await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		expect(FakeAudioContext.live).toBe(1)
	})

	// Every failure path is retried from media events, SPA nav, the URL poll and
	// three storage watchers, so one leak per attempt exhausts the cap in seconds.
	it('closes the context when the worklet module fails to load', async () => {
		const engine = await freshEngine()
		FakeSoundTouchNode.register.mockRejectedValue(new Error('404'))

		await expect(engine.ensureGraph(makeVideo(), PROCESSOR_URL)).rejects.toThrow('404')

		expect(FakeAudioContext.created).toHaveLength(1)
		expect(FakeAudioContext.live).toBe(0)
		expect(engine.hasGraph).toBe(false)
	})

	it('does not leak across repeated failed builds', async () => {
		const engine = await freshEngine()
		FakeSoundTouchNode.register.mockRejectedValue(new Error('404'))

		for (let i = 0; i < 8; i++) {
			await engine.ensureGraph(makeVideo(), PROCESSOR_URL).catch(() => {})
		}

		expect(FakeAudioContext.live).toBe(0)
	})

	// Returning the in-flight promise for a different element resolves
	// "successfully" against the OLD <video>: the caller then applies pitch to an
	// element that is not playing, and the one that is stays uncaptured.
	it('does not resolve a concurrent build against the wrong element', async () => {
		const engine = await freshEngine()
		const first = makeVideo()
		const second = makeVideo()

		let release!: () => void
		FakeSoundTouchNode.register
			.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
			.mockResolvedValue(undefined)

		const a = engine.ensureGraph(first, PROCESSOR_URL)
		const b = engine.ensureGraph(second, PROCESSOR_URL)
		// build() awaits dispose() before it reaches register(), so the blocking
		// promise does not exist yet at this point in the turn.
		await new Promise((r) => setTimeout(r, 0))
		release()
		await Promise.all([a, b])

		engine.applyTempo(1.5)
		expect(second.playbackRate).toBe(1.5)
		expect(first.playbackRate).toBe(1)
	})

	it('joins an in-flight build for the same element without rebuilding', async () => {
		const engine = await freshEngine()
		const el = makeVideo()

		await Promise.all([
			engine.ensureGraph(el, PROCESSOR_URL),
			engine.ensureGraph(el, PROCESSOR_URL),
		])

		expect(FakeAudioContext.created).toHaveLength(1)
	})

	// resume() resolving is not proof the context resumed — autoplay policy can
	// leave it suspended, and a suspended context on a captured element is silence.
	it('reports running only once the context has actually resumed', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		expect(engine.running).toBe(false)
		await engine.resume()
		expect(engine.running).toBe(true)
	})

	it('dispose closes the context and clears the graph', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		await engine.dispose()

		expect(engine.hasGraph).toBe(false)
		expect(FakeAudioContext.live).toBe(0)
	})
})

describe('AudioEngine — quality', () => {
	it('applies the stored quality at build time', async () => {
		const engine = await freshEngine()
		engine.applyQuality({ overlapMs: 30, quickSeek: false })

		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		expect(currentWorklet().setStretchParameters).toHaveBeenCalledWith({
			overlapMs: 30,
			quickSeek: false,
		})
	})

	it('pushes a quality change into a live graph', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		currentWorklet().setStretchParameters.mockClear()

		engine.applyQuality({ overlapMs: 5, quickSeek: true })

		expect(currentWorklet().setStretchParameters).toHaveBeenCalledWith({
			overlapMs: 5,
			quickSeek: true,
		})
	})
})
