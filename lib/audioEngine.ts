import { SoundTouchNode } from '@soundtouchjs/audio-worklet'

// Side-effect-free modules — safe to pull into the MAIN-world bundle, unlike
// `storage.ts` which touches extension APIs unavailable in the page realm.
import { DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@/lib/audioQuality'
import { isNoOp } from '@/lib/settings'

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
 *  - An AudioContext starts `suspended`; it must be resumed from a user gesture.
 *
 * Tempo: slowing the video is done by setting the **element's** `playbackRate`
 * (which lowers pitch like a record), then mirroring that to the SoundTouch
 * `playbackRate` AudioParam so the worklet compensates pitch back to normal.
 * Transpose (`pitchSemitones`) stacks on top, independent of tempo.
 *
 * On YouTube the same `<video>` element persists across SPA navigations, so a
 * single graph built once serves every video; only the parameters change.
 */
class AudioEngine {
	private ctx: AudioContext | null = null
	private source: MediaElementAudioSourceNode | null = null
	private node: SoundTouchNode | null = null
	private element: HTMLMediaElement | null = null
	private building: Promise<void> | null = null
	/** Which element the in-flight `building` promise is capturing, if any. */
	private buildingFor: HTMLMediaElement | null = null
	private semitones = 0
	private tempo = 1
	private quality: AudioQuality = DEFAULT_AUDIO_QUALITY
	/**
	 * Whether we are the ones currently driving `element.playbackRate`. YouTube's
	 * own speed menu writes the same property, so "off" may only reset the rate to
	 * 1 when the value sitting there is ours — otherwise disabling transpose would
	 * silently undo the speed the viewer picked in the player.
	 */
	private drivingRate = false

	/**
	 * The graph is bypassed (source wired straight to speakers) at the no-op:
	 * no transpose AND original speed. Bypassing matters because
	 * `createMediaElementSource` is one-shot, so without it every video runs
	 * through continuous WSOLA processing even when untouched — needless CPU.
	 */
	private get bypassed(): boolean {
		return isNoOp({ semitones: this.semitones, tempo: this.tempo })
	}

	/**
	 * Build the graph for `el` if not already built. Idempotent and safe to await
	 * repeatedly, including concurrently for different elements.
	 */
	async ensureGraph(el: HTMLMediaElement, processorUrl: string): Promise<void> {
		if (this.element === el && this.node) return

		if (this.building) {
			// Join an in-flight build only when it is capturing the same element.
			if (this.buildingFor === el) return this.building
			// Otherwise YouTube swapped the <video> mid-build. Returning the in-flight
			// promise would resolve "successfully" while the graph points at the OLD
			// element — the caller then applies pitch/tempo to an element that is no
			// longer playing, and the one that is stays uncaptured until some unrelated
			// later apply happens to rebuild. Let it settle, then build for real.
			await this.building.catch(() => {})
			return this.ensureGraph(el, processorUrl)
		}

		this.buildingFor = el
		this.building = this.build(el, processorUrl).finally(() => {
			this.building = null
			this.buildingFor = null
		})
		return this.building
	}

	private async build(el: HTMLMediaElement, processorUrl: string): Promise<void> {
		// YouTube sometimes swaps the <video> element (ads, miniplayer↔watch). A new
		// element falls past the ensureGraph guard into a rebuild — close the prior
		// context first, or each swap leaks an AudioContext. Browsers cap the number
		// of live contexts (~6 in Chrome); past the cap `new AudioContext()` throws
		// and audio dies. Closing also releases the old element back to direct output.
		await this.dispose()

		// 'playback' over the default 'interactive': a larger output buffer gives the
		// SoundTouch WSOLA pipeline more slack to fill each render quantum. At the tiny
		// interactive buffer the worklet sometimes can't produce a full block in time,
		// zero-fills the gap, and that gap is the audible click while transposing. We
		// don't need low latency — this is offline-style playback, not live monitoring.
		const ctx = new AudioContext({ latencyHint: 'playback' })
		// Adopt the context BEFORE anything that can throw. `register` fetches the
		// worklet module over the network and `createMediaElementSource` throws if the
		// element was captured before — and a context we never stored is one `dispose`
		// can never close. Since every failure path is retried (media events, SPA nav,
		// the URL poll, three storage watchers), leaking one per attempt would burn
		// through the cap in seconds and take audio down for the rest of the page.
		this.ctx = ctx
		try {
			await SoundTouchNode.register(ctx, processorUrl)

			const node = new SoundTouchNode({ context: ctx })
			// Apply the user-tunable WSOLA timing. `quickSeek: false` runs the full
			// cross-correlation search per overlap-add splice instead of the fast
			// approximation; a wider `overlapMs` lengthens the crossfade between splices,
			// hiding discontinuities. Tradeoff is CPU and a touch more smearing — exposed
			// in the options page so users can trade artifacts against CPU.
			node.setStretchParameters(this.quality)
			const source = ctx.createMediaElementSource(el)

			this.node = node
			this.source = source
			this.element = el
			this.route()
		} catch (err) {
			await this.dispose()
			throw err
		}
	}

	/**
	 * Wire the source either straight to the speakers (bypass) or through the
	 * SoundTouch worklet. Either branch always reaches `destination`, so the
	 * element never goes silent (the "never fully disconnect" rule). Reconnecting
	 * causes a small audible seam, so callers only re-route when crossing the
	 * bypass boundary.
	 */
	private route(): void {
		if (!this.ctx || !this.source || !this.node) return
		this.source.disconnect()
		this.node.disconnect()
		try {
			if (this.bypassed) {
				// Restore native speed + pitch preservation; the worklet's params are moot
				// while disconnected.
				this.releaseRate()
				this.source.connect(this.ctx.destination)
			} else {
				this.applyLive()
				this.source.connect(this.node)
				this.node.connect(this.ctx.destination)
			}
		} catch (err) {
			// Never leave the source stranded between the disconnect above and a
			// connect. `applyLive` writes restricted floats (`AudioParam.value`,
			// `element.playbackRate`) that throw on a value the clamps didn't catch —
			// and a captured element can no longer fall back to direct output, so a
			// throw here would mute the video permanently with no recovery short of a
			// reload. Fall back to the bypass wiring, then rethrow.
			this.source.disconnect()
			this.source.connect(this.ctx.destination)
			throw err
		}
	}

	/** Push the current params into the live graph without re-routing (no seam). */
	private applyLive(): void {
		if (!this.node) return
		this.node.pitchSemitones.value = this.semitones
		this.node.playbackRate.value = this.tempo
		if (!this.element) return

		if (this.tempo === 1) {
			// No time-stretch asked for, so hand the rate back to the page: the worklet
			// is compensating nothing (its `playbackRate` param is 1), and forcing
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

	/**
	 * Whether the context is actually processing. `resume()` resolving is not proof
	 * of this — autoplay policy can leave the context suspended, and a suspended
	 * context on a captured element means silence, not passthrough.
	 */
	get running(): boolean {
		return this.ctx?.state === 'running'
	}

	/** Apply pitch shift in semitones (tempo untouched). */
	applySemitones(semitones: number): void {
		const was = this.bypassed
		this.semitones = semitones
		if (was !== this.bypassed) this.route()
		else this.applyLive()
	}

	/** Apply playback rate (1 = original); pitch is compensated by the worklet. */
	applyTempo(tempo: number): void {
		const was = this.bypassed
		this.tempo = tempo
		if (was !== this.bypassed) this.route()
		else this.applyLive()
	}

	/** Update the WSOLA tuning, live if the graph already exists. */
	applyQuality(quality: AudioQuality): void {
		this.quality = quality
		this.node?.setStretchParameters(quality)
	}

	/** Resume the context from a user gesture; harmless if already running. */
	async resume(): Promise<void> {
		if (this.ctx && this.ctx.state !== 'running') {
			await this.ctx.resume()
		}
	}

	/**
	 * Tear down the graph and close the context. Used on element swap (above), so
	 * repeated swaps don't exhaust the browser's context cap, and on real page
	 * unload. Note that closing does NOT hand the captured element back to the
	 * speakers — per spec its output is simply ignored from then on — which is why
	 * a swap must rebuild rather than merely dispose.
	 */
	async dispose(): Promise<void> {
		this.node?.disconnect()
		this.source?.disconnect()
		this.releaseRate()
		const ctx = this.ctx
		this.ctx = null
		this.node = null
		this.source = null
		this.element = null
		if (ctx && ctx.state !== 'closed') {
			// A close that silently fails is what drives the context cap to exhaustion,
			// after which `new AudioContext()` throws and audio is dead for the page.
			// Don't swallow it — this is the one failure we most need to see.
			await ctx.close().catch((err) => console.error('[modulate] context close failed', err))
		}
	}
}

export const audioEngine = new AudioEngine()
