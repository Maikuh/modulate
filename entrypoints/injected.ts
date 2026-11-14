import { AudioBlockedError, audioEngine } from '@/lib/audioEngine'
import {
	APPLY_EVENT,
	PLAYING_EVENT,
	STATUS_EVENT,
	parseApplyMessage,
	type ApplyMessage,
	type AudioStatus,
	type PlayingMessage,
	type StatusMessage,
} from '@/lib/messaging'
import { NO_OP, isNoOp } from '@/lib/settings'

/**
 * Runs in the page's MAIN world (injected by the content script). Owns the Web
 * Audio graph, which cannot live in the content-script sandbox: Firefox throws
 * `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created
 * `processorOptions` object into the page-realm worklet.
 *
 * The content script can't reach the page realm directly either, so it forwards
 * the resolved settings here — pitch, tempo and the worklet URL (which only the content script can resolve, having the extension
 * APIs) — as `APPLY_EVENT`s on the `<script>` element that loaded this file, and
 * hears back via `STATUS_EVENT`s on the same element. The payload is a JSON
 * string: primitives cross the content/page membrane without `cloneInto`.
 */
/**
 * Page-realm slot for the instance that owns the audio graph: a function that
 * adopts another content script's channel.
 */
export const INSTANCE_KEY = Symbol.for('modulate.injected')

type Adopt = (channel: EventTarget) => void

export default defineUnlistedScript(() => {
	// The <script> element that loaded us is the channel to our content script. Only
	// readable now, while this file is executing synchronously.
	const channel = document.currentScript
	if (!channel) {
		console.error('[modulate] loaded without a <script> element; cannot reach the extension')
		return
	}

	// Firefox re-runs content scripts in open tabs when the extension updates, and
	// the new content script injects this file again. The first instance owns the
	// captured <video> — a second could never capture it, and would open and close a
	// context on every trigger trying — so later copies hand their channel to it and
	// stand down (the old content script stood its engine down on invalidation, and
	// the new one's messages then reach the engine that owns the element).
	const page = window as Window & { [INSTANCE_KEY]?: Adopt }
	const running = page[INSTANCE_KEY]
	if (typeof running === 'function') {
		running(channel)
		return
	}

	/** Find the player's media element (mounts late on first load). */
	function findVideo(): HTMLVideoElement | null {
		// Separate queries rather than one selector list: `querySelector` returns the
		// first match in TREE order, so a list hands back any stray <video> that
		// happens to precede the player (feed hover-previews, inline players) and the
		// specific selector never wins. Capture is one-shot and irreversible, so
		// binding the wrong element cannot be undone.
		//
		// Shorts play in a player of their own, and once both have been visited both
		// stay in the page: the URL says which one is in use. The main player also
		// plays the miniplayer, over the feed.
		const player = location.pathname.startsWith('/shorts/') ? '#shorts-player' : '#movie_player'
		return (
			document.querySelector<HTMLVideoElement>(`${player} video`) ??
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
	// Set when the autoplay policy refused to start audio; cleared by the first
	// gesture in the page. Without it, every trigger while we wait (each message,
	// each media event) would open and close another probe context, and Chrome
	// logs a console warning for each one.
	let blocked = false

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

	/**
	 * Every channel adopted so far. Reports go to all of them: the newest content
	 * script is the one listening, and a dead one's element just drops the event.
	 */
	const channels = new Set<EventTarget>()

	/** Tell the content script how the latest apply went (see `AudioStatus`). */
	function report(status: AudioStatus): void {
		const msg: StatusMessage = { source: 'modulate-page', type: 'status', status }
		const detail = JSON.stringify(msg)
		for (const ch of channels) ch.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }))
	}

	async function drain(): Promise<void> {
		while (dirty) {
			dirty = false
			const msg = lastMsg
			if (!msg) continue
			let status: AudioStatus | null
			try {
				status = await apply(msg)
			} catch (err) {
				console.error('[modulate] audio apply failed', err)
				status = 'error'
			}
			// Superseded (`null`) or overtaken mid-flight: only the latest gets reported.
			if (status && !dirty) report(status)
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
			blocked = false
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
	 * While the transpose waits for a gesture, play the tempo natively: it needs no
	 * audio context, so there is no reason to hold it back too.
	 */
	function waitNatively(el: HTMLVideoElement, msg: ApplyMessage): AudioStatus {
		audioEngine.attach(el)
		audioEngine.apply({ semitones: 0, tempo: msg.tempo })
		return 'waiting-for-gesture'
	}

	/**
	 * Converge the engine onto `msg`. Only ever called by `drain`, one at a time.
	 * After each await it bails if `lastMsg` moved meanwhile (`dirty`): the worker
	 * loops straight on to the newer message, so a stale one is never applied.
	 * Resolves to the outcome, or null when superseded.
	 */
	async function apply(msg: ApplyMessage): Promise<AudioStatus | null> {
		if (isNoOp(msg)) {
			// Lazy capture: leave the <video> untouched until a transpose is asked for.
			// `createMediaElementSource` is irreversible and reroutes ALL audio through
			// Web Audio — capturing for a no-op needlessly exposes normal playback to any
			// graph/worklet fault.
			if (!audioEngine.hasElement) return 'idle'
			// An element is already bound: return it to native playback in place WITHOUT
			// re-resolving it. Leaving a watch page for the feed resolves to a no-op, and
			// `findVideo` off a watch page can legitimately match a hover-preview — which
			// would send `ensureGraph` down its element-swap path, irreversibly capturing
			// the wrong <video> and moving the worklet off the player.
			audioEngine.apply(NO_OP)
			return 'applied'
		}

		// Only a transpose needs the graph; tempo alone is the element's native
		// time-stretch, which needs neither a capture nor a gesture.
		const needsGraph = msg.semitones !== 0

		const el = await waitForVideo()
		if (dirty) return null
		if (!el) {
			// Ten seconds with no <video>. The media-event replay can't fire (no element
			// was ever bound); only the next message from the content script retries.
			console.warn('[modulate] no <video> found; settings not applied')
			return 'no-video'
		}
		// Bind (or rebind on swap) the lifecycle listeners so a later media reload or
		// YouTube-driven rate reset triggers a replay without waiting for the next nav.
		trackVideo(el)
		// The autoplay policy already refused this page; don't ask again until the
		// page sees a gesture. Once a graph exists, re-applies never ask at all.
		if (needsGraph && !audioEngine.hasGraph && blocked) return waitNatively(el, msg)
		if (needsGraph) {
			try {
				await audioEngine.ensureGraph(el, msg.processorUrl)
			} catch (err) {
				// The first build asks the browser whether audio may start, and captures
				// nothing when it may not. That can't be predicted from here: sticky
				// activation (`navigator.userActivation`) is one way in, but browsers also
				// let trusted sites start audio without it — Chrome's media engagement
				// score, which regular YouTube viewers clear, or a Firefox per-site
				// permission. When the answer is no, wait for a pointerdown/keydown in the
				// page itself: popup clicks and shortcuts happen in another browsing
				// context and grant this document nothing.
				if (!(err instanceof AudioBlockedError)) throw err
				blocked = true
				hookGesture()
				return dirty ? null : waitNatively(el, msg)
			}
			if (dirty) return null
		} else {
			audioEngine.attach(el)
		}
		audioEngine.apply({ semitones: msg.semitones, tempo: msg.tempo })
		// A captured element is audible only while its context runs, bypassed or not.
		// The build only captures into a running context, but a browser can still
		// suspend one later (e.g. on some audio-session interruptions).
		if (!audioEngine.captures(el)) return 'applied'
		await audioEngine.resume()
		if (!audioEngine.running) {
			console.warn('[modulate] audio context did not resume; click the page to start audio')
			hookGesture()
			return 'waiting-for-gesture'
		}
		return 'applied'
	}

	/** YouTube's player element, with the part of its API we read. */
	type Player = HTMLElement & {
		getVideoData?: () => { video_id?: unknown; title?: unknown } | undefined
	}

	/** The last video reported as playing in the main player. */
	let playing: string | null = null

	/**
	 * Tell the content script which video the main player holds, when that changed.
	 * Only the player API knows once the URL stops naming it: the miniplayer plays
	 * over the feed, and autoplays the next video there without a navigation. During
	 * an ad it still names the video the ad runs before.
	 */
	function reportPlaying(): void {
		let data: ReturnType<NonNullable<Player['getVideoData']>>
		try {
			data = document.querySelector<Player>('#movie_player')?.getVideoData?.()
		} catch {
			return // YouTube's API, not ours: a throw here must not break the page.
		}
		const videoId = data?.video_id
		if (typeof videoId !== 'string' || !videoId || videoId === playing) return
		playing = videoId
		const msg: PlayingMessage = {
			source: 'modulate-page',
			type: 'playing',
			videoId,
			title: typeof data?.title === 'string' ? data.title : null,
		}
		const detail = JSON.stringify(msg)
		for (const ch of channels) ch.dispatchEvent(new CustomEvent(PLAYING_EVENT, { detail }))
	}

	// Media events don't bubble, but a capturing listener on the document hears every
	// element's. `loadstart` marks a new video (or ad) loading; by `loadeddata` and
	// `playing` the player API has caught up with it.
	for (const type of ['loadstart', 'loadeddata', 'playing']) {
		document.addEventListener(
			type,
			(event) => {
				if ((event.target as Element).closest?.('#movie_player')) reportPlaying()
			},
			true,
		)
	}

	// The browser can suspend the context after the build (some audio-session
	// interruptions), which silences a captured element whatever the routing. Re-run
	// the latest apply: it reports the wait (and arms the gesture retry), or that
	// audio is back.
	audioEngine.onStateChange(() => {
		if (lastMsg) schedule()
	})

	function onApply(event: Event): void {
		const detail = (event as CustomEvent<unknown>).detail
		if (typeof detail !== 'string') return

		const msg = parseApplyMessage(detail)
		if (!msg) return

		lastMsg = msg
		schedule()
	}

	const adopt: Adopt = (ch) => {
		if (channels.has(ch)) return
		channels.add(ch)
		ch.addEventListener(APPLY_EVENT, onApply)
		// A new listener knows nothing yet: tell it what the player already holds.
		playing = null
		reportPlaying()
	}
	page[INSTANCE_KEY] = adopt
	adopt(channel)

	// Close the AudioContext on real unload only. Skipping bfcache (`persisted`)
	// keeps the frozen graph intact for restore — and avoids re-capturing the same
	// <video> on the way back, which `createMediaElementSource` forbids.
	window.addEventListener('pagehide', (event) => {
		if (!event.persisted) void audioEngine.dispose()
	})
})
