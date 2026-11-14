import { storage } from 'wxt/utils/storage'

import { formatSemitones } from '@/lib/format'
import {
	APPLY_EVENT,
	PLAYING_EVENT,
	STATUS_EVENT,
	logSendFailure,
	parsePlayingMessage,
	parseStatusMessage,
	type ApplyMessage,
	type AudioStatus,
	type BadgeMessage,
	type PopupMessage,
	type PopupResponse,
	type PlayerState,
} from '@/lib/messaging'
import { DEFAULT_VIDEO_SETTING, NO_OP, resolveSetting, type ResolvedSetting } from '@/lib/settings'
import {
	globalEnabled,
	getRawVideoSetting,
	setVideoSetting,
	watchVideoSettings,
} from '@/lib/storage'
import { removeToast, showToast } from '@/lib/toast'
import { getVideoId, getVideoTitle } from '@/lib/youtube'

/** Set on `ytd-app` while YouTube's miniplayer is open. */
const MINIPLAYER_ATTR = 'miniplayer-is-active'

/** How often to check whether the extension was disabled, updated or removed. */
export const INVALIDATION_POLL_MS = 1000

export default defineContentScript({
	matches: ['*://*.youtube.com/*'],
	main(ctx) {
		// The worklet URL must be resolved here — the main-world script has no
		// access to extension APIs like `browser.runtime.getURL`.
		const processorUrl = browser.runtime.getURL('/signalsmith-processor.js')

		// Inject the audio engine into the page's MAIN world. It can't live in this
		// sandbox: Firefox throws DataCloneError when an AudioWorkletNode serializes
		// a sandbox object into the page-realm worklet. Load via `src` (not inline)
		// so YouTube's CSP doesn't block it — which is also why this isn't WXT's
		// `injectScript`: on MV2 (our Firefox build) it inlines the script text.
		//
		// The element doubles as the private channel to the page script: we talk over
		// CustomEvents dispatched on it, where `window.postMessage` would broadcast
		// every message to every script in the page. It is removed from the DOM once
		// loaded; events still dispatch on a detached element.
		const channel = document.createElement('script')
		const injected = new Promise<void>((resolve, reject) => {
			channel.src = browser.runtime.getURL('/injected.js')
			channel.addEventListener(
				'load',
				() => {
					channel.remove()
					resolve()
				},
				{ once: true },
			)
			channel.addEventListener('error', () => reject(new Error('failed to inject audio engine')), {
				once: true,
			})
			;(document.head ?? document.documentElement).append(channel)
		})
		injected.catch((err) => {
			console.error('[modulate]', err)
			setAudioStatus('error')
		})

		// What the page engine last reported, and the badge it annotates. The engine
		// answers each apply asynchronously, so the badge is re-sent when it does.
		let audioStatus: AudioStatus = 'idle'
		// Bumped with every status change, so the popup can order a reply it got
		// against a later status push (see `PlayerState.audioSeq`).
		let audioSeq = 0
		let lastBadge: Omit<BadgeMessage, 'status' | 'audioSeq'> | null = null

		function setAudioStatus(status: AudioStatus): void {
			if (status === audioStatus) return
			audioStatus = status
			audioSeq++
			sendBadge()
		}

		function sendBadge(): void {
			if (!lastBadge) return
			const badge: BadgeMessage = { ...lastBadge, status: audioStatus, audioSeq }
			// Logged rather than swallowed: a lost badge message means the toolbar keeps
			// advertising the PREVIOUS video's state, which is worse than blank. Routine
			// when the extension was reloaded under this tab or the tab is closing.
			browser.runtime.sendMessage(badge).catch((err) => logSendFailure('badge update dropped', err))
		}

		ctx.addEventListener(channel, STATUS_EVENT, (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail
			if (typeof detail !== 'string') return
			const status = parseStatusMessage(detail)
			if (status) setAudioStatus(status)
		})

		/** What the page's main player holds, as the page last reported it. */
		let playing: { videoId: string; title: string | null } | null = null

		ctx.addEventListener(channel, PLAYING_EVENT, (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail
			if (typeof detail !== 'string') return
			const next = parsePlayingMessage(detail)
			if (!next || next.videoId === playing?.videoId) return
			playing = next
			// The miniplayer moved on to another video (autoplay) with no navigation.
			if (getVideoId(location.href) == null && miniplayerActive()) {
				scheduleApply('miniplayer-video')
			}
		})

		/** Whether YouTube's miniplayer is open (it plays over the feed). */
		function miniplayerActive(): boolean {
			return document.querySelector('ytd-app')?.hasAttribute(MINIPLAYER_ATTR) ?? false
		}

		/**
		 * The video this tab is on: the one the URL names, or the miniplayer's while it
		 * plays over a page that names none. Only while it is open: the player keeps
		 * the last video's ID after the miniplayer closes.
		 */
		function currentVideo(): { videoId: string | null; title: string | undefined } {
			const fromUrl = getVideoId(location.href)
			if (fromUrl != null) return { videoId: fromUrl, title: getVideoTitle(fromUrl) ?? undefined }
			if (playing && miniplayerActive()) {
				return { videoId: playing.videoId, title: playing.title ?? undefined }
			}
			return { videoId: null, title: undefined }
		}

		/** Read the state the popup needs to render the controls. */
		async function getState(): Promise<PlayerState> {
			const { videoId } = currentVideo()
			const global = await globalEnabled.getValue()
			const setting = (videoId && (await getRawVideoSetting(videoId))) || DEFAULT_VIDEO_SETTING
			return {
				videoId,
				globalEnabled: global,
				enabled: setting.enabled,
				semitones: setting.semitones,
				tempo: setting.tempo,
				audio: audioStatus,
				audioSeq,
			}
		}

		let applySeq = 0

		/** Forward settings to the main-world engine. */
		function postApply(setting: ResolvedSetting): void {
			const msg: ApplyMessage = {
				source: 'modulate',
				type: 'apply',
				processorUrl,
				semitones: setting.semitones,
				tempo: setting.tempo,
			}
			// JSON string payload: primitives cross the content/page membrane without
			// `cloneInto`; a raw object would arrive as `null` in the page realm.
			channel.dispatchEvent(new CustomEvent(APPLY_EVENT, { detail: JSON.stringify(msg) }))
		}

		/** Resolve the effective pitch/tempo and forward them to the engine. */
		async function apply(): Promise<void> {
			if (!ctx.isValid) return
			const seq = ++applySeq
			const { videoId } = currentVideo()
			// Independent reads — fetch them concurrently rather than serially.
			const [global, video] = await Promise.all([
				globalEnabled.getValue(),
				videoId ? getRawVideoSetting(videoId) : Promise.resolve(undefined),
			])
			const resolved = resolveSetting(global, video)
			const badge: NonNullable<typeof lastBadge> = {
				type: 'MODULATE_BADGE',
				onVideo: videoId != null,
				semitones: resolved.semitones,
				tempo: resolved.tempo,
			}

			try {
				await injected // Ensure the page-world listener is registered.
			} catch (err) {
				// The engine never loaded, so nothing will apply. The `error` status was
				// set when the injection failed — but with no badge sent yet, it had
				// nothing to annotate: send this one, so the toolbar flags the failure
				// instead of staying blank.
				if (ctx.isValid && seq === applySeq) {
					lastBadge = badge
					sendBadge()
				}
				throw err
			}
			// Superseded: a later apply read newer storage and will post. Posting this one
			// after it would leave the page applying stale settings.
			if (!ctx.isValid || seq !== applySeq) return

			postApply(resolved)

			// Tell the background to render the toolbar badge for this tab.
			lastBadge = badge
			sendBadge()
		}

		/**
		 * Fire-and-forget `apply()`. Every trigger below is unattended, and `apply`
		 * rejects for real reasons — most notably a permanently rejected `injected`
		 * promise after a failed script injection, which poisons every later call.
		 * Without this the whole class of failure is an unhandled rejection nobody
		 * reads, while the popup and badge keep reporting success.
		 */
		function scheduleApply(reason: string): void {
			void apply().catch((err) => console.error(`[modulate] apply failed (${reason})`, err))
		}

		/**
		 * Serializes storage mutations. Every per-video write is read-modify-write —
		 * the `NUDGE_*` cases read the current value, and `setVideoSetting` itself
		 * rewrites the whole `videoSettings` record — so overlapping handlers lose
		 * updates: holding a keyboard shortcut fires on OS key repeat (~30/s), and
		 * without this every message in the burst reads the same starting value and
		 * writes the same result. A popup `SET_*` racing a shortcut loses one of the
		 * two changes the same way.
		 */
		let mutations: Promise<unknown> = Promise.resolve()
		function serialize<T>(work: () => Promise<T>): Promise<T> {
			const next = mutations.then(work, work)
			// Keep the chain alive past a rejection; the caller still sees the error.
			mutations = next.catch(() => {})
			return next
		}

		async function handle(msg: PopupMessage): Promise<PlayerState> {
			// Capture the readable title alongside any save so the options list is
			// legible. Undefined (never null) when unknown, so it can't clobber a stored one.
			const { videoId, title } = currentVideo()

			// No clamping here — `setVideoSetting` clamps every write, so the ranges are
			// enforced once at the storage boundary instead of at each call site.
			const shortcut = 'fromShortcut' in msg && msg.fromShortcut === true
			const nudge = (field: 'semitones' | 'tempo', delta: number) => async () => {
				if (!videoId) return
				const current = (await getRawVideoSetting(videoId)) ?? DEFAULT_VIDEO_SETTING
				// The popup greys its controls out while off; a shortcut has no controls
				// to grey, so it must not quietly move a value nobody can see.
				if (shortcut && !(current.enabled && (await globalEnabled.getValue()))) return
				await setVideoSetting(videoId, { [field]: current[field] + delta, title })
			}
			const write = (partial: Parameters<typeof setVideoSetting>[1]) => async () => {
				if (videoId) await setVideoSetting(videoId, { ...partial, title })
			}

			switch (msg.type) {
				case 'SET_SEMITONES':
					await serialize(write({ semitones: msg.semitones }))
					break
				case 'NUDGE_SEMITONES':
					await serialize(nudge('semitones', msg.delta))
					break
				case 'SET_TEMPO':
					await serialize(write({ tempo: msg.tempo }))
					break
				case 'NUDGE_TEMPO':
					await serialize(nudge('tempo', msg.delta))
					break
				case 'SET_VIDEO_ENABLED':
					await serialize(write({ enabled: msg.enabled }))
					break
				case 'SET_GLOBAL_ENABLED':
					await serialize(() => globalEnabled.setValue(msg.enabled))
					break
				case 'RESET':
					await serialize(write({ ...DEFAULT_VIDEO_SETTING }))
					break
				case 'GET_STATE':
					break
				default: {
					// Exhaustiveness check. Without it a new PopupMessage variant compiles,
					// falls through every case, and still trips the `!== 'GET_STATE'` test
					// below — silently firing an apply for a message nothing handled.
					const unhandled: never = msg
					console.warn('[modulate] unhandled message', unhandled)
					return getState()
				}
			}

			// GET_STATE is a pure read fired on popup mount — never touch the audio
			// graph, or the response would block on graph build / context resume.
			if (msg.type !== 'GET_STATE') {
				// A mutating message changed the desired state: (re)apply. Fire-and-forget so
				// the popup's response isn't held up by graph build or context resume.
				scheduleApply(msg.type)
			}
			const state = await getState()
			if (shortcut) showToast(shortcutNotice(msg.type, state))
			return state
		}

		/** What a shortcut did, for the on-page notice. */
		function shortcutNotice(type: PopupMessage['type'], state: PlayerState): string {
			if (state.videoId == null) return 'Modulate: open a video to tune it'
			if (!state.globalEnabled) return 'Modulate is off'
			if (!state.enabled) return 'Modulate is off for this video'
			return type === 'NUDGE_TEMPO'
				? `Tempo ${state.tempo.toFixed(2)}×`
				: `Pitch ${formatSemitones(state.semitones)} st`
		}

		browser.runtime.onMessage.addListener(
			(msg: PopupMessage, _sender, sendResponse: (r: PopupResponse) => void) => {
				handle(msg).then(
					(state) => sendResponse({ ok: true, state }),
					(err) => {
						// ALWAYS answer. Dropping the response leaves the channel open until the
						// port closes, at which point the popup's `sendMessage` rejects and
						// renders as "no content script here" — so a storage failure would show
						// up as a button that silently does nothing.
						console.error('[modulate] message failed', msg?.type, err)
						sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
					},
				)
				return true // keep the channel open for the async response
			},
		)

		// Re-apply on YouTube's SPA navigation (same element, new video ID). Sync
		// `lastUrl` so the location watcher below doesn't fire a second redundant apply.
		let lastUrl = location.href
		ctx.addEventListener(document, 'yt-navigate-finish', () => {
			lastUrl = location.href
			scheduleApply('navigation')
		})

		// Fallback: catch URL changes the event might miss. WXT's watcher uses the
		// Navigation API where the browser has it and polls the URL otherwise.
		//
		// On the Navigation API path the event fires from `navigate`, BEFORE the URL
		// commits: `location.href` still reads the page being left. So compare the
		// event's own destination, and read `location` (as `apply` does) only a task
		// later, once the history entry has committed. Comparing `location.href` here
		// would match `lastUrl` on every navigation and never re-apply.
		ctx.addEventListener(window, 'wxt:locationchange', (event) => {
			const url = (event as Event & { newUrl?: URL }).newUrl?.href ?? location.href
			if (url === lastUrl) return
			lastUrl = url
			ctx.setTimeout(() => scheduleApply('location-change'), 0)
		})

		// Back from the back/forward cache: the page was frozen, not reloaded, so this
		// script never restarted — but settings may have changed while it was away (a
		// watcher can't fire into a frozen page), and the browser may have suspended
		// the audio context. Re-apply, which also re-reports the engine's status.
		ctx.addEventListener(window, 'pageshow', (event) => {
			if ((event as PageTransitionEvent).persisted) scheduleApply('bfcache-restore')
		})

		// Re-apply when settings change elsewhere (another tab, the options page edits
		// storage directly), so the active tab reflects edits live. Only this tab's
		// own video matters: a write for any other video changes nothing here.
		const unwatchers = [
			watchVideoSettings((ids) => {
				const { videoId } = currentVideo()
				if (videoId && ids.includes(videoId)) scheduleApply('videoSettings')
			}),
			storage.watch('local:globalEnabled', () => scheduleApply('globalEnabled')),
		]
		ctx.onInvalidated(() => {
			// The page-realm engine outlives this script: disabling, updating or
			// uninstalling the extension invalidates us, but the worklet module is already
			// loaded and keeps processing. Stand it down so the video doesn't stay
			// transposed (and time-stretched) until a reload. First, before anything that
			// touches the extension APIs this context just lost, which may throw.
			postApply(NO_OP)
			for (const off of unwatchers) {
				try {
					off()
				} catch (err) {
					console.debug('[modulate] could not remove a storage watcher', err)
				}
			}
		})

		// Opening or closing the miniplayer changes which video this tab is on without
		// a navigation of its own: opening it is one (to the feed, which `currentVideo`
		// then resolves to the miniplayer's video), but closing it is not.
		// Records fire on every write of the attribute, a rewrite of the same state
		// included: act on changes only.
		let miniplayerWas = miniplayerActive()
		const miniplayerWatch = new MutationObserver(() => {
			const now = miniplayerActive()
			if (now === miniplayerWas) return
			miniplayerWas = now
			scheduleApply('miniplayer')
		})
		miniplayerWatch.observe(document.documentElement, {
			subtree: true,
			attributes: true,
			attributeFilter: [MINIPLAYER_ATTR],
		})
		ctx.onInvalidated(() => {
			miniplayerWatch.disconnect()
			removeToast()
		})

		// WXT notices invalidation only when something reads `ctx.isValid` (which
		// checks `browser.runtime.id`), or when a newer copy of this script starts. On
		// the Navigation API path nothing polls, so after the extension is disabled
		// the video would stay transposed until the next navigation. `ctx.setInterval`
		// reads `isValid` before every tick, which is the whole check: cheap, and it
		// wakes nothing in the background.
		ctx.setInterval(() => {}, INVALIDATION_POLL_MS)

		scheduleApply('startup')
	},
})
