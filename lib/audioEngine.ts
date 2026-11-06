// Side-effect-free modules — safe to pull into the MAIN-world bundle, unlike
// `storage.ts` which touches extension APIs unavailable in the page realm.
import type { ResolvedSetting } from '@/lib/settings'
import { createStretchNode, type StretchNode } from '@/lib/stretchNode'

/**
 * Owns the Web Audio graph that pitch-shifts and time-stretches a single media
 * element.
 *
 * This MUST run in the page's main world, not a content-script sandbox. The
 * `AudioWorkletNode` constructor serializes `processorOptions` into the worklet,
 * which lives in the page realm; Firefox cannot structured-clone a content-script
 * sandbox object across that membrane and throws `DataCloneError` (even for
 * string-only payloads). Running here, every object is page-realm and clones fine.
 *
 * Critical Web Audio constraints this encodes:
 *
 *  - `createMediaElementSource` may be called only ONCE per element, for the
 *    lifetime of the document — not once per context. A second call throws
 *    `InvalidStateError` even from a fresh context, and closing the old context
 *    does not release the element.
 *    After it runs, the element stops outputting to speakers directly — all
 *    audio flows through this graph. So when transpose is "off" we keep the
 *    graph wired and bypass it rather than disconnecting (which would mute the
 *    element).
 *  - An AudioContext only runs once the browser's autoplay policy allows it —
 *    after a user gesture in the page, or earlier where the browser trusts the
 *    site (Chrome's media engagement, a Firefox per-site autoplay permission).
 *    Capturing into a context that never starts plays the element silently, so
 *    `build()` checks the context actually runs BEFORE capturing.
 *
 * Tempo is always the **element's** `playbackRate`, in one of two modes:
 *
 *  - Tempo alone (no transpose) is the browser's own job: `preservesPitch = true`
 *    holds pitch natively (Firefox runs SoundTouch internally, Chrome WSOLA). No
 *    graph, no capture, no click in the page needed — and nothing of ours to fail.
 *  - With a transpose, the worklet is in the path anyway, so the element resamples
 *    raw (`preservesPitch = false`, pitch drops like a record) and the worklet's
 *    shift undoes that in the same pass as the transpose (`stretchSemitones`).
 *    One stretch, not two.
 *
 * On YouTube the same `<video>` element persists across SPA navigations, so a
 * single graph built once serves every video; only the parameters change.
 */
/**
 * How long the build waits for a fresh context to start before concluding the
 * autoplay policy refused it. Generous on purpose: an allowed context usually runs
 * within tens of milliseconds, but reading a slow start as a refusal would make a
 * viewer who already clicked the page click again — while a real refusal only
 * delays the "click the page" notice by this much.
 */
const START_TIMEOUT_MS = 1000

/**
 * The browser won't let an AudioContext run in this page yet (autoplay policy).
 * Nothing was captured; building again after a gesture in the page will work.
 */
export class AudioBlockedError extends Error {
	constructor() {
		super('audio is blocked until the page is clicked or typed in')
		this.name = 'AudioBlockedError'
	}
}

class AudioEngine {
	private ctx: AudioContext | null = null
	private source: MediaElementAudioSourceNode | null = null
	private node: StretchNode | null = null
	/** The element the graph captured; `null` while there is no graph. */
	private graphElement: HTMLMediaElement | null = null
	/**
	 * The element whose rate we control: the graph's element once there is a graph,
	 * or the one bound with `attach` for a native (graph-less) tempo change.
	 */
	private element: HTMLMediaElement | null = null
	/** The in-flight build, and the element it is capturing. */
	private building: { el: HTMLMediaElement; promise: Promise<void> } | null = null
	/**
	 * Every element this engine has ever captured. Capture is per document, not per
	 * context, so an element whose context was disposed (YouTube swapped it out, then
	 * back in) can never be captured again — checked up front so that case fails
	 * with a message that says so, instead of churning a context per retry into a
	 * generic `InvalidStateError`.
	 */
	private captured = new WeakSet<HTMLMediaElement>()
	/**
	 * The worklet raised `processorerror`: it outputs silence from then on, so the
	 * graph stays bypassed until an element swap builds a fresh one.
	 */
	private failed = false
	private semitones = 0
	private tempo = 1
	/**
	 * Whether we are the ones currently driving `element.playbackRate`. YouTube's
	 * own speed menu writes the same property, so "off" may only reset the rate to
	 * 1 when the value sitting there is ours — otherwise disabling transpose would
	 * silently undo the speed the viewer picked in the player.
	 */
	private drivingRate = false

	/**
	 * The graph is bypassed (source wired straight to speakers) whenever there is
	 * no transpose: tempo alone is the browser's native time-stretch, so the worklet
	 * has nothing to do. Bypassing matters because `createMediaElementSource` is
	 * one-shot, so without it every video runs through continuous phase-vocoder
	 * processing even when untouched — needless CPU. A crashed worklet is bypassed too, since
	 * routing through it is silence; tempo still works there, natively.
	 */
	private get bypassed(): boolean {
		return this.failed || this.semitones === 0
	}

	/**
	 * Bind `el` as the element whose rate tempo drives, without capturing it — the
	 * native tempo path needs no graph. Hands a previously bound element back to
	 * the page first (YouTube swapped it).
	 */
	attach(el: HTMLMediaElement): void {
		if (this.element === el) return
		this.releaseRate()
		this.element = el
	}

	/**
	 * Build the graph for `el` if not already built. Idempotent and safe to await
	 * repeatedly, including concurrently for different elements.
	 */
	async ensureGraph(el: HTMLMediaElement, processorUrl: string): Promise<void> {
		if (this.graphElement === el && this.node) return

		if (this.building) {
			// Join an in-flight build only when it is capturing the same element.
			if (this.building.el === el) return this.building.promise
			// Otherwise YouTube swapped the <video> mid-build. Returning the in-flight
			// promise would resolve "successfully" while the graph points at the OLD
			// element — the caller then applies pitch/tempo to an element that is no
			// longer playing, and the one that is stays uncaptured until some unrelated
			// later apply happens to rebuild. Let it settle, then build for real.
			await this.building.promise.catch(() => {})
			return this.ensureGraph(el, processorUrl)
		}

		const promise = this.build(el, processorUrl).finally(() => {
			this.building = null
		})
		this.building = { el, promise }
		return promise
	}

	private async build(el: HTMLMediaElement, processorUrl: string): Promise<void> {
		// YouTube sometimes swaps the <video> element (ads, miniplayer↔watch). A new
		// element falls past the ensureGraph guard into a rebuild — close the prior
		// context first, or each swap leaks an AudioContext. Browsers cap the number
		// of live contexts; past the cap `new AudioContext()` throws and audio dies.
		// Closing does NOT hand the old element back to direct output (its output is
		// just ignored from then on), which is why the swap has to build a new graph.
		// The rate is left alone: a native tempo already playing on `el` keeps playing
		// through the build instead of blipping back to 1× and forward again.
		await this.disposeGraph()

		if (this.captured.has(el)) {
			throw new Error(
				'this <video> was captured by an earlier audio graph and cannot be captured again; reload the page',
			)
		}

		// 'playback' over the default 'interactive': a larger output buffer gives the
		// worklet more slack before a late render quantum becomes an audible gap. We
		// don't need low latency — this is offline-style playback, not live monitoring.
		const ctx = new AudioContext({ latencyHint: 'playback' })
		// Adopt the context BEFORE anything that can throw. `register` fetches the
		// worklet module over the network and `createMediaElementSource` throws if the
		// element was captured before — and a context we never stored is one `dispose`
		// can never close. Since every failure path is retried (media events, SPA nav,
		// the URL poll, three storage watchers), leaking one per attempt would burn
		// through the cap in seconds and take audio down for the rest of the page.
		this.ctx = ctx
		let node: StretchNode
		let source: MediaElementAudioSourceNode
		try {
			// Ask the autoplay policy before anything irreversible. A context that won't
			// run would leave the captured element playing silently — and capture can't
			// be undone — so if it doesn't start, close it and let the caller retry after
			// a gesture. This is a real check, not a guess from `userActivation`: browsers
			// also let trusted sites start audio without one (Chrome's media engagement
			// score, which YouTube regulars clear easily; Firefox's per-site permission).
			await this.resume(START_TIMEOUT_MS)
			if (ctx.state !== 'running') throw new AudioBlockedError()

			node = await createStretchNode(ctx, processorUrl)
			source = ctx.createMediaElementSource(el)
		} catch (err) {
			await this.disposeGraph()
			throw err
		}

		// Captured. From here on the element outputs ONLY through this context, so no
		// failure past this point may dispose it: a closed context ignores the
		// element's output and the element can never be captured again — the video
		// would stay muted until a reload. Keep the graph; `route()` falls back to the
		// bypass wiring on a throw, which keeps the video audible.
		this.captured.add(el)
		this.node = node
		this.source = source
		this.graphElement = el
		this.attach(el)
		// The worklet trails its input by ~140–150 ms (`lib/stretchNode.test.ts`) and
		// the video isn't delayed to match; this is the context's share on top of that,
		// which only the browser knows.
		console.debug('[modulate] audio graph built; context latency (s)', {
			base: ctx.baseLatency,
			output: ctx.outputLatency,
		})
		node.input.addEventListener('processorerror', (event) => {
			if (this.node !== node) return
			console.error('[modulate] audio worklet crashed; bypassing it', event)
			this.failed = true
			this.route()
		})
		this.route()
	}

	/**
	 * Wire the source either straight to the speakers (bypass) or through the
	 * stretch worklet. Either branch always reaches `destination`, so the
	 * element never goes silent (the "never fully disconnect" rule). Reconnecting
	 * causes a small audible seam, so callers only re-route when crossing the
	 * bypass boundary.
	 */
	private route(): void {
		if (!this.ctx || !this.source || !this.node) return
		this.source.disconnect()
		this.node.output.disconnect()
		this.node.setActive(!this.bypassed)
		try {
			if (this.bypassed) {
				// Tempo goes native (pitch preserved by the element); the worklet's params
				// are moot while disconnected.
				this.applyNativeRate()
				this.source.connect(this.ctx.destination)
			} else {
				this.applyLive()
				this.source.connect(this.node.input)
				this.node.output.connect(this.ctx.destination)
			}
		} catch (err) {
			// Never leave the source stranded between the disconnect above and a
			// connect. `applyLive` writes `element.playbackRate`, a restricted float that
			// throws on a value the clamps didn't catch —
			// and a captured element can no longer fall back to direct output, so a
			// throw here would mute the video permanently with no recovery short of a
			// reload. Fall back to the bypass wiring, then rethrow.
			//
			// Record the no-op as the current state, so it matches that wiring. Left at
			// the rejected values, a later change that stays on the same side of the
			// bypass boundary would skip `route()` and drive the element's rate with
			// pitch preservation off while nothing compensates it.
			this.semitones = 0
			this.tempo = 1
			this.releaseRate()
			this.node.setActive(false)
			this.source.disconnect()
			this.source.connect(this.ctx.destination)
			throw err
		}
	}

	/** Push the current params into the live graph without re-routing (no seam). */
	private applyLive(): void {
		if (!this.node || this.bypassed) {
			this.applyNativeRate()
			return
		}
		this.node.set(this.semitones, this.tempo)
		if (!this.element) return

		if (this.tempo === 1) {
			// No time-stretch asked for, so hand the rate back to the page: the worklet
			// is compensating nothing (the shift is the transpose alone), and forcing
			// `preservesPitch = false` here would make any speed the viewer picks in
			// YouTube's own menu resample raw — pitch rising with speed, uncorrected,
			// on top of whatever transpose is active. Pitch shift alone must leave the
			// player's speed control behaving natively.
			this.releaseRate()
			return
		}

		// The worklet compensates pitch assuming the element does a RAW resample
		// (pitch drops with speed). Browsers default `preservesPitch = true`, which
		// would hold pitch in the element and make the worklet's compensation a
		// double-correction — speed would then shift pitch. Turn it off so the
		// element feeds the worklet the resampled signal its math expects.
		this.setPreservesPitch(false)
		this.element.playbackRate = this.tempo
		this.drivingRate = true
	}

	/**
	 * Tempo without the worklet: the element time-stretches with its own pitch
	 * preservation. At tempo 1 the rate is the page's (see `releaseRate`).
	 */
	private applyNativeRate(): void {
		if (this.tempo === 1 || !this.element) {
			this.releaseRate()
			return
		}
		this.setPreservesPitch(true)
		this.element.playbackRate = this.tempo
		this.drivingRate = true
	}

	/**
	 * Return the element to native playback: pitch preservation back on, and the
	 * rate reset to 1 only if we were the one driving it (see `drivingRate`).
	 */
	private releaseRate(): void {
		if (!this.element) return
		this.setPreservesPitch(true)
		if (this.drivingRate) {
			this.element.playbackRate = 1
			this.drivingRate = false
		}
	}

	/** Set `preservesPitch` with the legacy vendor-prefixed fallbacks. */
	private setPreservesPitch(value: boolean): void {
		const el = this.element as
			| (HTMLMediaElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean })
			| null
		if (!el) return
		el.preservesPitch = value
		if ('mozPreservesPitch' in el) el.mozPreservesPitch = value
		if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = value
	}

	/** Whether the graph has been built (the video is already captured). */
	get hasGraph(): boolean {
		return this.node !== null
	}

	/** Whether an element is bound (by a graph or a native tempo change). */
	get hasElement(): boolean {
		return this.element !== null
	}

	/**
	 * Whether `el`'s audio flows through our context — then it is only audible while
	 * the context runs, whatever the routing.
	 */
	captures(el: HTMLMediaElement): boolean {
		return this.node !== null && this.graphElement === el
	}

	/**
	 * Whether the context is actually processing. `resume()` resolving is not proof
	 * of this — autoplay policy can leave the context suspended, and a suspended
	 * context on a captured element means silence, not passthrough.
	 */
	get running(): boolean {
		return this.ctx?.state === 'running'
	}

	/**
	 * Apply pitch (semitones) and/or playback rate (1 = original; pitch is
	 * compensated by the worklet). Setting both in one call re-routes at most once,
	 * and each re-route is an audible seam.
	 */
	apply(setting: Partial<ResolvedSetting>): void {
		const was = this.bypassed
		if (setting.semitones !== undefined) this.semitones = setting.semitones
		if (setting.tempo !== undefined) this.tempo = setting.tempo
		if (this.node && was !== this.bypassed) this.route()
		else this.applyLive()
	}

	/**
	 * Try to start the context; harmless if already running. Bounded: a context the
	 * autoplay policy won't start leaves `resume()` pending — per spec it neither
	 * resolves nor rejects until the page gets activation — and an unbounded await
	 * would hang the caller, and every apply queued behind it. Callers check
	 * `running` afterwards rather than trusting this to have succeeded.
	 */
	async resume(timeoutMs = 250): Promise<void> {
		const ctx = this.ctx
		if (!ctx || ctx.state === 'running') return
		let timer: ReturnType<typeof setTimeout> | undefined
		const settled = ctx
			.resume()
			.catch((err) => console.warn('[modulate] audio context resume failed', err))
		await Promise.race([settled, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
		clearTimeout(timer)
	}

	/**
	 * Tear down the graph and hand the element back to native playback. Used on real
	 * page unload. Note that closing does NOT hand a captured element back to the
	 * speakers — per spec its output is simply ignored from then on.
	 */
	async dispose(): Promise<void> {
		await this.disposeGraph()
		this.releaseRate()
		this.element = null
	}

	/**
	 * Close the context and drop the graph, leaving the element's rate as it is.
	 * Used on element swap (above), so repeated swaps don't exhaust the browser's
	 * context cap — a swap must rebuild rather than merely dispose, since closing
	 * does not release the captured element.
	 */
	private async disposeGraph(): Promise<void> {
		this.node?.output.disconnect()
		this.source?.disconnect()
		const ctx = this.ctx
		this.ctx = null
		this.node = null
		this.source = null
		this.graphElement = null
		this.failed = false
		if (ctx && ctx.state !== 'closed') {
			// A close that silently fails is what drives the context cap to exhaustion,
			// after which `new AudioContext()` throws and audio is dead for the page.
			// Don't swallow it — this is the one failure we most need to see.
			await ctx.close().catch((err) => console.error('[modulate] context close failed', err))
		}
	}
}

export const audioEngine = new AudioEngine()
