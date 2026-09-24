import { audioEngine } from '@/lib/audioEngine'
import { parseApplyMessage, type ApplyMessage } from '@/lib/messaging'
import { NO_OP, isNoOp } from '@/lib/settings'

/**
 * Runs in the page's MAIN world (injected by the content script). Owns the Web
 * Audio graph, which cannot live in the content-script sandbox: Firefox throws
 * `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created
 * `processorOptions` object into the page-realm worklet.
 *
 * The content script can't reach the page realm directly either, so it forwards
 * the resolved settings here via `window.postMessage` — pitch, tempo, the WSOLA
 * quality knobs, and the worklet URL (which only the content script can resolve,
 * having the extension APIs). The payload is a JSON string: primitives cross the
 * content/page membrane without `cloneInto`.
 */
/** Page-realm marker for the instance that owns the audio graph. */
export const INSTANCE_KEY = Symbol.for('modulate.injected')

export default defineUnlistedScript(() => {
	// Firefox re-runs content scripts in open tabs when the extension updates, and
	// the new content script injects this file again. The first instance owns the
	// captured <video> — a second could never capture it, and would open and close a
	// context on every trigger trying — so later copies stand down and leave the
	// page to it (the old content script stood its engine down on invalidation, and
	// the new one's messages reach the same listener).
	const page = window as Window & { [INSTANCE_KEY]?: true }
	if (page[INSTANCE_KEY]) return
	page[INSTANCE_KEY] = true

	/** Find the player's media element (mounts late on first load). */
	function findVideo(): HTMLVideoElement | null {
		// Two queries rather than one selector list: `querySelector` returns the first
		// match in TREE order, so `'video.html5-main-video, video'` hands back any
		// stray <video> that happens to precede the player (feed hover-previews,
		// inline players) and the specific selector never wins. Capture is one-shot
		// and irreversible, so binding the wrong element cannot be undone.
		return (
			document.querySelector<HTMLVideoElement>('video.html5-main-video') ??
			document.querySelector<HTMLVideoElement>('video')
		)
	}

	/** Resolve once a <video> exists, or null after a timeout. */
	function waitForVideo(timeoutMs = 10_000): Promise<HTMLVideoElement | null> {
		const existing = findVideo()
		if (existing) return Promise.resolve(existing)

		return new Promise((resolve) => {
			// Cleared on the observer path: this watches the whole document with
			// `subtree: true` on one of the most mutation-heavy pages on the web, and
			// apply() can be in flight from several triggers at once.
			let timer: ReturnType<typeof setTimeout>
			const observer = new MutationObserver(() => {
				const el = findVideo()
				if (el) {
					observer.disconnect()
					clearTimeout(timer)
					resolve(el)
				}
			})
			observer.observe(document.documentElement, { childList: true, subtree: true })
			timer = setTimeout(() => {
				observer.disconnect()
				resolve(findVideo())
			}, timeoutMs)
		})
	}

	// Latest effective settings from the content script: the one desired state.
	// Every trigger — a new message, a media-event replay, the first-gesture retry
	// — asks for THIS to be applied, never for a message captured earlier. So a
	// reset that lands while an older change is still waiting (for a gesture, for
	// the <video>, for the graph build) cannot be overtaken by that older change.
	let lastMsg: ApplyMessage | null = null
	let gestureHooked = false

	// One worker converges the engine onto `lastMsg`. `dirty` marks that it moved
	// since the worker last read it; the worker loops until it settles.
	let dirty = false
	let draining = false

	/** Ask for `lastMsg` to be (re)applied. Bursts coalesce; the latest always wins. */
	function schedule(): void {
		dirty = true
		if (draining) return
		draining = true
		void drain()
	}

	async function drain(): Promise<void> {
		while (dirty) {
			dirty = false
			const msg = lastMsg
			if (!msg) continue
			try {
				await apply(msg)
			} catch (err) {
				console.error('[modulate] audio apply failed', err)
			}
		}
		// Cleared in the same turn the loop exits, so a `schedule()` can never find
		// `draining` set by a worker that has already stopped reading `dirty`.
		draining = false
	}

	// The <video> we've bound lifecycle listeners to. YouTube reuses one element
	// across most SPA navigations but swaps it for ads/miniplayer; we rebind on swap.
	let tracked: HTMLVideoElement | null = null

	// `loadstart`/`emptied` bracket the player tearing down one clip and starting the
	// next. Re-applying there — not only on the nav event, which fires before the
	// media is ready — closes the window where a fresh clip plays untransposed.
	// `ratechange` is not a load event; it catches YouTube writing the element's
	// playbackRate out from under us, which would strand the worklet compensating
	// for a rate the element no longer has.
	const MEDIA_EVENTS = ['loadstart', 'emptied', 'ratechange'] as const

	function onMediaEvent(event: Event): void {
		const msg = lastMsg
		if (!msg) return
		if (event.type === 'ratechange') {
			const el = event.target as HTMLVideoElement
			// At tempo 1 the element's rate is not ours to hold: `applyLive` has handed
			// it back to the page (pitch preservation on, worklet compensating nothing),
			// so YouTube's speed menu owns it and we must not fight it.
			if (msg.tempo === 1) return
			// Otherwise ignore the ratechange our own tempo apply just triggered — this
			// is also what stops apply → playbackRate → ratechange → apply looping.
			if (el.playbackRate === msg.tempo) return
		}
		schedule()
	}

	/** Bind lifecycle listeners to the current <video>, moving them on element swap. */
	function trackVideo(el: HTMLVideoElement): void {
		if (tracked === el) return
		if (tracked) for (const type of MEDIA_EVENTS) tracked.removeEventListener(type, onMediaEvent)
		tracked = el
		for (const type of MEDIA_EVENTS) el.addEventListener(type, onMediaEvent)
	}

	/** Re-apply the latest settings once the page sees its first gesture. */
	function hookGesture(): void {
		if (gestureHooked) return
		gestureHooked = true
		const retry = () => {
			gestureHooked = false
			// Drop both listeners — the first gesture fires one; the sibling would
			// otherwise linger (and re-arming on a later defer would stack them).
			window.removeEventListener('pointerdown', retry, true)
			window.removeEventListener('keydown', retry, true)
			schedule()
		}
		window.addEventListener('pointerdown', retry, { capture: true })
		window.addEventListener('keydown', retry, { capture: true })
	}

	/**
	 * Converge the engine onto `msg`. Only ever called by `drain`, one at a time.
	 * After each await it bails if `lastMsg` moved meanwhile (`dirty`): the worker
	 * loops straight on to the newer message, so a stale one is never applied.
	 */
	async function apply(msg: ApplyMessage): Promise<void> {
		if (isNoOp(msg)) {
			// Lazy capture: leave the <video> untouched until a real change (transpose or
			// tempo) is asked for. `createMediaElementSource` is irreversible and reroutes
			// ALL audio through Web Audio — capturing for a no-op needlessly exposes
			// normal playback to any graph/worklet fault.
			if (!audioEngine.hasGraph) return
			// A graph already exists: bypass it in place and return WITHOUT re-resolving
			// the element. Leaving a watch page for the feed resolves to a no-op, and
			// `findVideo` off a watch page can legitimately match a hover-preview — which
			// would send `ensureGraph` down its element-swap path, disposing the working
			// context and irreversibly capturing the wrong <video>.
			audioEngine.apply(NO_OP)
			return
		}

		// Defer the FIRST graph build until the page has user activation. Building
		// captures the element (irreversibly) and routes its audio through a context
		// that starts `suspended`; without activation `resume()` can't run, so the
		// captured element would play silently.
		//
		// Note this gates EVERY trigger, popup clicks included. `hasBeenActive` is a
		// property of THIS window, and the popup is a separate browsing context at a
		// chrome-extension:// origin — clicking it grants the YouTube document
		// nothing. So a pitch change made from the popup on an autoplaying page that
		// the user never clicked queues here like any auto-apply, until the first
		// pointerdown/keydown in the page itself.
		//
		// When the activation API is unavailable (older Firefox) we can't tell, so we
		// fall through and build anyway. Once a graph exists, re-applies are cheap.
		const ua = navigator.userActivation
		if (!audioEngine.hasGraph && ua && !ua.hasBeenActive) {
			hookGesture()
			return
		}

		const el = await waitForVideo()
		if (dirty) return
		if (!el) {
			// Ten seconds with no <video>. The media-event replay can't fire (no element
			// was ever bound); only the next message from the content script retries.
			console.warn('[modulate] no <video> found; settings not applied')
			return
		}
		// Bind (or rebind on swap) the lifecycle listeners so a later media reload or
		// YouTube-driven rate reset triggers a replay without waiting for the next nav.
		trackVideo(el)
		// Set quality before the graph is built so `ensureGraph` constructs with it.
		audioEngine.applyQuality({
			overlapMs: msg.overlapMs,
			quickSeek: msg.quickSeek,
		})
		await audioEngine.ensureGraph(el, msg.processorUrl)
		if (dirty) return
		audioEngine.apply({ semitones: msg.semitones, tempo: msg.tempo })
		// Best-effort: the gate above means we normally arrive with activation, but
		// the older-Firefox fallthrough can reach here without it, in which case the
		// context stays suspended and the captured element plays silently.
		await audioEngine.resume()
		if (!audioEngine.running) {
			console.warn('[modulate] audio context did not resume; click the page to start audio')
			hookGesture()
		}
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window || typeof event.data !== 'string') return

		const msg = parseApplyMessage(event.data)
		if (!msg) return

		lastMsg = msg
		schedule()
	})

	// Close the AudioContext on real unload only. Skipping bfcache (`persisted`)
	// keeps the frozen graph intact for restore — and avoids re-capturing the same
	// <video> on the way back, which `createMediaElementSource` forbids.
	window.addEventListener('pagehide', (event) => {
		if (!event.persisted) void audioEngine.dispose()
	})
})
