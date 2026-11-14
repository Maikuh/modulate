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
class FakeNode extends EventTarget {
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

/**
 * The stretch node `createStretchNode` hands back for each context: the worklet
 * (`input`) wired permanently to its output stage (`output`), as the real one is.
 */
class FakeStretch {
	/** Stands in for the worklet module load; tests make it fail or block. */
	static load = vi.fn<(ctx: unknown, url: string) => Promise<void>>()
	/** The node built for each context, so tests can reach it. */
	static byContext = new WeakMap<FakeAudioContext, FakeStretch>()

	readonly input = new FakeNode()
	readonly output = new FakeNode()
	/** What the engine last asked the worklet for. */
	semitones = 0
	tempo = 1
	active = false
	set = vi.fn((semitones: number, tempo: number) => {
		this.semitones = semitones
		this.tempo = tempo
	})
	setActive = vi.fn((active: boolean) => {
		this.active = active
	})

	constructor(ctx: FakeAudioContext) {
		this.input.connect(this.output)
		FakeStretch.byContext.set(ctx, this)
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
	/** The source node this context handed out last, so tests can reach it. */
	source?: FakeNode
	/** Every source node it handed out, by element. */
	readonly sources = new Map<unknown, FakeNode>()

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
		this.sources.set(el, this.source)
		return this.source
	}

	/**
	 * Whether the autoplay policy lets a context start. When it doesn't, `resume()`
	 * stays pending, as the spec has it — it neither resolves nor rejects.
	 */
	static allowStart = true

	resume(): Promise<void> {
		if (!FakeAudioContext.allowStart) return new Promise(() => {})
		this.state = 'running'
		return Promise.resolve()
	}

	async close(): Promise<void> {
		this.closeCalls++
		if (this.state !== 'closed') FakeAudioContext.live--
		this.state = 'closed'
	}

	static reset(): void {
		FakeAudioContext.allowStart = true
		FakeAudioContext.live = 0
		FakeAudioContext.created = []
		FakeAudioContext.captured = new Set()
	}
}

vi.mock('@/lib/stretchNode', () => ({
	createStretchNode: async (ctx: FakeAudioContext, url: string) => {
		await FakeStretch.load(ctx, url)
		return new FakeStretch(ctx)
	},
}))

const PROCESSOR_URL = 'chrome-extension://abc/signalsmith-processor.js'

/** The engine is a module singleton, so each test needs a fresh module graph. */
async function freshEngine() {
	vi.resetModules()
	const mod = await import('@/lib/audioEngine')
	AudioBlockedError = mod.AudioBlockedError
	return mod.audioEngine
}

/** From the same fresh module graph as the engine, so `instanceof` holds. */
let AudioBlockedError: typeof import('@/lib/audioEngine').AudioBlockedError

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

function currentWorklet(): FakeStretch {
	const node = FakeStretch.byContext.get(currentCtx())
	if (!node) throw new Error('no worklet built for this context')
	return node
}

beforeEach(() => {
	FakeAudioContext.reset()
	FakeStretch.load = vi.fn<(ctx: unknown, url: string) => Promise<void>>()
	FakeStretch.load.mockResolvedValue(undefined)
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

		engine.apply({ semitones: 0 })
		engine.apply({ tempo: 1 })

		expect(currentSource().reaches(currentCtx().destination)).toBe(true)
	})

	it('routes through the worklet when transposing', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		engine.apply({ semitones: 5 })

		const source = currentSource()
		expect(source.reaches(currentCtx().destination)).toBe(true)
		// ...via the worklet, not straight past it.
		expect(source.outputs.has(currentCtx().destination)).toBe(false)
		expect(source.outputs.has(currentWorklet().input)).toBe(true)
	})

	it('still reaches destination after crossing the bypass boundary both ways', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const source = currentSource()
		const { destination } = currentCtx()

		for (const step of [
			() => engine.apply({ semitones: 4 }),
			() => engine.apply({ semitones: 0 }),
			() => engine.apply({ tempo: 1.5 }),
			() => engine.apply({ tempo: 1 }),
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

		expect(() => engine.apply({ semitones: 3, tempo: 1.5 })).toThrow(TypeError)
		expect(source.reaches(currentCtx().destination)).toBe(true)
	})

	// After the fallback the source bypasses the worklet. Had the engine kept the
	// rejected values, a later change on the same side of the bypass boundary would
	// skip route() and leave the worklet disconnected while still time-stretching.
	it('records the no-op after a failed route, so the next change re-routes', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		const worklet = currentWorklet()
		const setRate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate')
		let fail = true
		Object.defineProperty(el, 'playbackRate', {
			set(v: number) {
				if (fail) throw new TypeError('rejected')
				setRate?.set?.call(el, v)
			},
			get: () => setRate?.get?.call(el) as number,
			configurable: true,
		})

		expect(() => engine.apply({ semitones: 3, tempo: 1.5 })).toThrow(TypeError)
		fail = false
		engine.apply({ semitones: 3, tempo: 1.25 })

		expect(currentSource().outputs.has(worklet.input)).toBe(true)
		expect(el.preservesPitch).toBe(false)
	})

	it('sets pitch and tempo together with a single re-route', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const disconnect = vi.spyOn(currentSource(), 'disconnect')

		engine.apply({ semitones: 3, tempo: 1.5 })

		expect(disconnect).toHaveBeenCalledOnce()
		expect(currentWorklet().semitones).toBe(3)
		expect(currentWorklet().tempo).toBe(1.5)
	})

	// A crashed worklet outputs silence forever. Routing around it keeps the video
	// audible (untransposed) instead of muted until a reload — and the tempo keeps
	// working, natively.
	it('bypasses a worklet that raised processorerror, and stays bypassed', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.apply({ semitones: 4, tempo: 1.5 })

		currentWorklet().input.dispatchEvent(new Event('processorerror'))

		const { destination } = currentCtx()
		expect(currentSource().outputs.has(destination)).toBe(true)
		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(1.5)

		engine.apply({ semitones: 5, tempo: 1.25 })
		expect(currentSource().outputs.has(destination)).toBe(true)
		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(1.25)
	})

	it('pushes pitch and tempo into the worklet params', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		engine.apply({ semitones: -3 })
		engine.apply({ tempo: 0.75 })

		expect(currentWorklet().semitones).toBe(-3)
		expect(currentWorklet().tempo).toBe(0.75)
	})
})

describe('AudioEngine — native tempo', () => {
	// Tempo alone is the browser's own time-stretch: no worklet, pitch preserved by
	// the element itself.
	it('keeps the worklet out of the path for tempo alone', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.apply({ tempo: 1.5 })

		expect(currentSource().outputs.has(currentCtx().destination)).toBe(true)
		expect(currentSource().outputs.has(currentWorklet().input)).toBe(false)
		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(1.5)
	})

	it('drives an attached element without building a graph', async () => {
		const engine = await freshEngine()
		const el = makeVideo()

		engine.attach(el)
		engine.apply({ semitones: 0, tempo: 0.75 })

		expect(FakeAudioContext.created).toHaveLength(0)
		expect(engine.hasGraph).toBe(false)
		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(0.75)
	})

	it('hands the old element back when another is attached', async () => {
		const engine = await freshEngine()
		const first = makeVideo()
		const second = makeVideo()
		engine.attach(first)
		engine.apply({ tempo: 1.5 })

		engine.attach(second)
		engine.apply({ tempo: 1.5 })

		expect(first.playbackRate).toBe(1)
		expect(second.playbackRate).toBe(1.5)
	})

	// The build awaits the autoplay probe and the module fetch; a native tempo that
	// is already playing must not drop to 1× for that long and jump back.
	it('keeps a native tempo playing through a graph build', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		engine.attach(el)
		engine.apply({ tempo: 1.5 })
		const rates: number[] = []
		FakeStretch.load.mockImplementation(async () => {
			rates.push(el.playbackRate)
		})

		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.apply({ semitones: 4 })

		expect(rates).toEqual([1.5])
		expect(el.preservesPitch).toBe(false)
		expect(el.playbackRate).toBe(1.5)
		expect(currentWorklet().tempo).toBe(1.5)
	})

	it('switches pitch preservation back on when the transpose is dropped', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.apply({ semitones: 3, tempo: 1.25 })
		expect(el.preservesPitch).toBe(false)

		engine.apply({ semitones: 0 })

		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(1.25)
	})
})

describe('AudioEngine — element rate ownership', () => {
	it('disables preservesPitch only when time-stretching', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.apply({ semitones: 5 }) // pitch only, tempo still 1
		expect(el.preservesPitch).toBe(true)

		engine.apply({ tempo: 1.5 })
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

		engine.apply({ semitones: 5 })
		el.playbackRate = 2 // the viewer picks 2x in the player
		engine.apply({ semitones: 6 }) // another pitch nudge must not stomp it

		expect(el.playbackRate).toBe(2)
		expect(el.preservesPitch).toBe(true)
	})

	it('resets the rate on bypass only when it was driving it', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)

		engine.apply({ tempo: 1.5 })
		expect(el.playbackRate).toBe(1.5)
		engine.apply({ tempo: 1 })
		expect(el.playbackRate).toBe(1) // ours, so we clean it up

		el.playbackRate = 1.75 // now the page's
		engine.apply({ semitones: 3 })
		engine.apply({ semitones: 0 })
		expect(el.playbackRate).toBe(1.75) // not ours, so left alone
	})

	it('restores native playback on dispose', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.apply({ tempo: 0.5 })

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

	// YouTube swaps the <video> for ads and the miniplayer. Closing a context mutes
	// every element it captured for good, and browsers cap live contexts besides:
	// one context serves every element.
	it('keeps one context across element swaps', async () => {
		const engine = await freshEngine()
		for (let i = 0; i < 10; i++) await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		expect(FakeAudioContext.created).toHaveLength(1)
		expect(FakeAudioContext.live).toBe(1)
		expect(currentCtx().closeCalls).toBe(0)
		expect(currentCtx().sources.size).toBe(10)
	})

	// The element being left can only play through our context from now on.
	it('keeps the element being left audible, untransposed', async () => {
		const engine = await freshEngine()
		const first = makeVideo()
		await engine.ensureGraph(first, PROCESSOR_URL)
		engine.apply({ semitones: 3 })

		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		const { destination } = currentCtx()
		const left = currentCtx().sources.get(first)!
		expect(left.outputs.has(destination)).toBe(true)
		expect(left.outputs.has(currentWorklet().input)).toBe(false)
		// ...while the new element takes the worklet path.
		expect(currentSource().outputs.has(currentWorklet().input)).toBe(true)
	})

	// YouTube can swap an element out and later back in.
	it('switches back to an element captured earlier without capturing it again', async () => {
		const engine = await freshEngine()
		const first = makeVideo()
		const second = makeVideo()
		await engine.ensureGraph(first, PROCESSOR_URL)
		await engine.ensureGraph(second, PROCESSOR_URL)

		await engine.ensureGraph(first, PROCESSOR_URL)
		engine.apply({ semitones: 3, tempo: 1.5 })

		const ctx = currentCtx()
		expect(FakeAudioContext.created).toHaveLength(1)
		expect(FakeAudioContext.captured.size).toBe(2)
		expect(ctx.sources.get(first)!.outputs.has(currentWorklet().input)).toBe(true)
		expect(ctx.sources.get(second)!.outputs.has(ctx.destination)).toBe(true)
		expect(first.playbackRate).toBe(1.5)
		expect(second.playbackRate).toBe(1)
	})

	// A context the browser suspended since would play a newly captured element
	// silently, and the capture can't be undone.
	it('captures a new element only while the context runs', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const ctx = currentCtx()
		const playing = currentSource()
		ctx.state = 'suspended'
		FakeAudioContext.allowStart = false

		const next = makeVideo()
		vi.useFakeTimers()
		try {
			const outcome = engine.ensureGraph(next, PROCESSOR_URL).catch((err: unknown) => err)
			await vi.advanceTimersByTimeAsync(2000)
			expect(await outcome).toBeInstanceOf(AudioBlockedError)
		} finally {
			vi.useRealTimers()
		}

		expect(FakeAudioContext.captured.has(next)).toBe(false)
		expect(ctx.closeCalls).toBe(0)
		expect(playing.reaches(ctx.destination)).toBe(true)
	})

	it('gives a new element a fresh worklet after a crash', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const crashed = currentWorklet()
		crashed.input.dispatchEvent(new Event('processorerror'))

		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		engine.apply({ semitones: 4 })

		const fresh = currentWorklet()
		expect(fresh).not.toBe(crashed)
		expect(FakeAudioContext.created).toHaveLength(1)
		expect(currentSource().outputs.has(fresh.input)).toBe(true)
		expect(fresh.active).toBe(true)
	})

	it('stays bypassed when the fresh worklet fails to load too', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		currentWorklet().input.dispatchEvent(new Event('processorerror'))
		FakeStretch.load.mockRejectedValue(new Error('404'))

		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		engine.apply({ semitones: 4, tempo: 1.5 })

		expect(currentSource().outputs.has(currentCtx().destination)).toBe(true)
		expect(el.preservesPitch).toBe(true)
		expect(el.playbackRate).toBe(1.5)
	})

	// Something else (another extension) captured the element first.
	it('closes a context that captured nothing when the first capture throws', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		FakeAudioContext.captured.add(el)

		await expect(engine.ensureGraph(el, PROCESSOR_URL)).rejects.toThrow(/already connected/)

		expect(FakeAudioContext.live).toBe(0)
		expect(engine.hasGraph).toBe(false)
	})

	it('keeps the current element playing when a later capture throws', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const playing = currentSource()
		const taken = makeVideo()
		FakeAudioContext.captured.add(taken)

		await expect(engine.ensureGraph(taken, PROCESSOR_URL)).rejects.toThrow(/already connected/)

		expect(FakeAudioContext.live).toBe(1)
		expect(playing.reaches(currentCtx().destination)).toBe(true)
	})

	it('refuses an element captured into a context since closed', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		await engine.dispose()

		await expect(engine.ensureGraph(el, PROCESSOR_URL)).rejects.toThrow(/cannot be captured again/)
		expect(FakeAudioContext.created).toHaveLength(1)
	})

	// Every failure path is retried from media events, SPA nav, the URL poll and
	// three storage watchers, so one leak per attempt exhausts the cap in seconds.
	it('closes the context when the worklet module fails to load', async () => {
		const engine = await freshEngine()
		FakeStretch.load.mockRejectedValue(new Error('404'))

		await expect(engine.ensureGraph(makeVideo(), PROCESSOR_URL)).rejects.toThrow('404')

		expect(FakeAudioContext.created).toHaveLength(1)
		expect(FakeAudioContext.live).toBe(0)
		expect(engine.hasGraph).toBe(false)
	})

	// Past createMediaElementSource the element outputs only through this context.
	// Disposing on a later failure would close it: the element's output is then
	// ignored and it can never be captured again — muted until a reload.
	it('keeps a captured graph audible when routing fails during the build', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		engine.apply({ tempo: 1.5 }) // Pre-set so the build's first route() writes the rate.
		Object.defineProperty(el, 'playbackRate', {
			set() {
				throw new TypeError('rejected')
			},
			get: () => 1,
			configurable: true,
		})

		await expect(engine.ensureGraph(el, PROCESSOR_URL)).rejects.toThrow(TypeError)

		expect(engine.hasGraph).toBe(true)
		expect(FakeAudioContext.live).toBe(1)
		expect(currentSource().reaches(currentCtx().destination)).toBe(true)
	})

	it('does not leak across repeated failed builds', async () => {
		const engine = await freshEngine()
		FakeStretch.load.mockRejectedValue(new Error('404'))

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
		FakeStretch.load
			.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
			.mockResolvedValue(undefined)

		const a = engine.ensureGraph(first, PROCESSOR_URL)
		const b = engine.ensureGraph(second, PROCESSOR_URL)
		// build() awaits the context start before it reaches the module load, so the
		// blocking promise does not exist yet at this point in the turn.
		await new Promise((r) => setTimeout(r, 0))
		release()
		await Promise.all([a, b])

		engine.apply({ tempo: 1.5 })
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

	// Capture is irreversible, and an element captured into a context that never
	// starts plays silently. So the build asks first, and captures nothing on a no.
	it('captures only into a context the browser lets run', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		FakeAudioContext.allowStart = false

		vi.useFakeTimers()
		try {
			const outcome = engine.ensureGraph(el, PROCESSOR_URL).catch((err: unknown) => err)
			await vi.advanceTimersByTimeAsync(2000)
			expect(await outcome).toBeInstanceOf(AudioBlockedError)
		} finally {
			vi.useRealTimers()
		}

		expect(FakeAudioContext.captured.has(el)).toBe(false)
		expect(FakeAudioContext.live).toBe(0)
		expect(FakeStretch.load).not.toHaveBeenCalled()
		expect(engine.hasGraph).toBe(false)

		// After a gesture the same element is still capturable.
		FakeAudioContext.allowStart = true
		await engine.ensureGraph(el, PROCESSOR_URL)
		expect(engine.hasGraph).toBe(true)
		expect(engine.running).toBe(true)
	})

	// Without activation the browser may still allow audio (Chrome's media
	// engagement, a Firefox site permission): then the build goes straight ahead.
	it('builds without user activation when the browser allows audio', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		expect(engine.running).toBe(true)
	})

	// Per spec, resume() on a context the autoplay policy won't start stays pending.
	// Awaited unbounded, the build would hang along with every apply queued behind it.
	it('gives up on a context that never starts instead of hanging', async () => {
		vi.useFakeTimers()
		try {
			const engine = await freshEngine()
			FakeAudioContext.allowStart = false

			const outcome = engine.ensureGraph(makeVideo(), PROCESSOR_URL).catch((err: unknown) => err)
			await vi.advanceTimersByTimeAsync(2000)
			expect(await outcome).toBeInstanceOf(AudioBlockedError)
		} finally {
			vi.useRealTimers()
		}
	})

	it('dispose closes the context and clears the graph', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		await engine.dispose()

		expect(engine.hasGraph).toBe(false)
		expect(FakeAudioContext.live).toBe(0)
	})
})

describe('AudioEngine — worklet activity', () => {
	// An inactive Signalsmith worklet outputs silence, and an active one bypassed is
	// wasted CPU: it runs exactly while it is in the path.
	it('runs the worklet only while routed through it', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)
		const worklet = currentWorklet()
		expect(worklet.active).toBe(false)

		engine.apply({ semitones: 3 })
		expect(worklet.active).toBe(true)

		engine.apply({ semitones: 0, tempo: 1.5 })
		expect(worklet.active).toBe(false)
	})

	it('stops the worklet when a route falls back to the bypass', async () => {
		const engine = await freshEngine()
		const el = makeVideo()
		await engine.ensureGraph(el, PROCESSOR_URL)
		Object.defineProperty(el, 'playbackRate', {
			set() {
				throw new TypeError('rejected')
			},
			get: () => 1,
			configurable: true,
		})

		expect(() => engine.apply({ semitones: 3, tempo: 1.5 })).toThrow(TypeError)

		expect(currentWorklet().active).toBe(false)
	})

	it('hands the worklet the transpose and the tempo it compensates', async () => {
		const engine = await freshEngine()
		await engine.ensureGraph(makeVideo(), PROCESSOR_URL)

		engine.apply({ semitones: -4, tempo: 1.25 })

		expect(currentWorklet().set).toHaveBeenLastCalledWith(-4, 1.25)
	})
})
