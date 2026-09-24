import { storage } from 'wxt/utils/storage'

import { DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@/lib/audioQuality'
import type { ApplyMessage, BadgeMessage, PopupMessage, PlayerState } from '@/lib/messaging'
import { DEFAULT_VIDEO_SETTING, NO_OP, resolveSetting, type ResolvedSetting } from '@/lib/settings'
import { globalEnabled, getAudioQuality, getRawVideoSetting, setVideoSetting } from '@/lib/storage'
import { getVideoId, getVideoTitle } from '@/lib/youtube'

export default defineContentScript({
	matches: ['*://*.youtube.com/*'],
	main(ctx) {
		// The worklet URL must be resolved here — the main-world script has no
		// access to extension APIs like `browser.runtime.getURL`.
		const processorUrl = browser.runtime.getURL('/soundtouch-processor.js')

		// Inject the audio engine into the page's MAIN world. It can't live in this
		// sandbox: Firefox throws DataCloneError when an AudioWorkletNode serializes
		// a sandbox object into the page-realm worklet. Load via `src` (not inline)
		// so YouTube's CSP doesn't block it.
		const injected = new Promise<void>((resolve, reject) => {
			const script = document.createElement('script')
			script.src = browser.runtime.getURL('/injected.js')
			script.addEventListener(
				'load',
				() => {
					script.remove()
					resolve()
				},
				{ once: true },
			)
			script.addEventListener('error', () => reject(new Error('failed to inject audio engine')), {
				once: true,
			})
			;(document.head ?? document.documentElement).append(script)
		})
		injected.catch((err) => console.error('[modulate]', err))

		/** A safe, untransposed `PlayerState` — the shape every read starts from. */
		function baseState(): PlayerState {
			return {
				videoId: getVideoId(location.href),
				globalEnabled: true,
				enabled: DEFAULT_VIDEO_SETTING.enabled,
				semitones: DEFAULT_VIDEO_SETTING.semitones,
				tempo: DEFAULT_VIDEO_SETTING.tempo,
			}
		}

		/** Read the state the popup needs to render the controls. */
		async function getState(): Promise<PlayerState> {
			const videoId = getVideoId(location.href)
			const global = await globalEnabled.getValue()
			const base: PlayerState = { ...baseState(), globalEnabled: global }
			if (!videoId) return base

			const setting = (await getRawVideoSetting(videoId)) ?? DEFAULT_VIDEO_SETTING
			return {
				...base,
				enabled: setting.enabled,
				semitones: setting.semitones,
				tempo: setting.tempo,
			}
		}

		// Quality last forwarded, reused when standing the engine down on invalidation.
		let lastQuality: AudioQuality = { ...DEFAULT_AUDIO_QUALITY }
		let applySeq = 0

		/** Forward settings to the main-world engine. */
		function postApply(setting: ResolvedSetting, quality: AudioQuality): void {
			const msg: ApplyMessage = {
				source: 'modulate',
				type: 'apply',
				processorUrl,
				semitones: setting.semitones,
				tempo: setting.tempo,
				overlapMs: quality.overlapMs,
				quickSeek: quality.quickSeek,
			}
			// JSON string payload: primitives cross the content/page membrane without
			// `cloneInto`; a raw object would arrive as `null` in the page realm.
			window.postMessage(JSON.stringify(msg), '*')
		}

		/** Resolve the effective pitch/tempo + quality and forward them to the engine. */
		async function apply(): Promise<void> {
			if (!ctx.isValid) return
			const seq = ++applySeq
			const videoId = getVideoId(location.href)
			// Independent reads — fetch them concurrently rather than serially.
			const [global, quality, video] = await Promise.all([
				globalEnabled.getValue(),
				getAudioQuality(),
				videoId ? getRawVideoSetting(videoId) : Promise.resolve(undefined),
			])
			const resolved = resolveSetting(global, video)

			await injected // Ensure the page-world listener is registered.
			// Superseded: a later apply read newer storage and will post. Posting this one
			// after it would leave the page applying stale settings.
			if (!ctx.isValid || seq !== applySeq) return

			lastQuality = quality
			postApply(resolved, quality)

			// Tell the background to render the toolbar badge for this tab.
			const badge: BadgeMessage = {
				type: 'MODULATE_BADGE',
				onVideo: videoId != null,
				semitones: resolved.semitones,
				tempo: resolved.tempo,
			}
			browser.runtime.sendMessage(badge).catch((err) => {
				// Expected when the extension was reloaded or updated under this tab (its
				// context is invalidated) or the tab is closing; logged rather than
				// swallowed because a lost badge message means the toolbar keeps
				// advertising the PREVIOUS video's state, which is worse than blank.
				console.debug('[modulate] badge update dropped', err)
			})
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
			const videoId = getVideoId(location.href)
			// Capture the readable title alongside any save so the options list is
			// legible. `?? undefined` so a null title doesn't clobber a stored one.
			const title = getVideoTitle(videoId) ?? undefined

			// No clamping here — `setVideoSetting` clamps every write, so the ranges are
			// enforced once at the storage boundary instead of at each call site.
			const nudge = (field: 'semitones' | 'tempo', delta: number) => async () => {
				if (!videoId) return
				const current = (await getRawVideoSetting(videoId)) ?? DEFAULT_VIDEO_SETTING
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
			return getState()
		}

		browser.runtime.onMessage.addListener(
			(msg: PopupMessage, _sender, sendResponse: (s: PlayerState) => void) => {
				handle(msg).then(sendResponse, (err) => {
					// ALWAYS answer. Dropping the response leaves the channel open until the
					// port closes, at which point the popup's `sendMessage` rejects into its
					// blanket catch and renders as "no content script here" — so a storage
					// failure shows up as a button that silently does nothing.
					console.error('[modulate] message failed', msg?.type, err)
					sendResponse(baseState())
				})
				return true // keep the channel open for the async response
			},
		)

		// Re-apply on YouTube's SPA navigation (same element, new video ID). Sync
		// `lastUrl` so the poll below doesn't fire a second redundant apply.
		let lastUrl = location.href
		ctx.addEventListener(document, 'yt-navigate-finish', () => {
			lastUrl = location.href
			scheduleApply('navigation')
		})

		// Fallback: catch URL changes the event might miss.
		ctx.setInterval(() => {
			if (location.href !== lastUrl) {
				lastUrl = location.href
				scheduleApply('url-poll')
			}
		}, 1000)

		// Re-apply when settings change elsewhere (the options page edits storage
		// directly), so the active tab reflects edits live.
		const unwatchers = [
			storage.watch('local:videoSettings', () => scheduleApply('videoSettings')),
			storage.watch('local:audioQuality', () => scheduleApply('audioQuality')),
			storage.watch('local:globalEnabled', () => scheduleApply('globalEnabled')),
		]
		ctx.onInvalidated(() => {
			unwatchers.forEach((off) => off())
			// The page-realm engine outlives this script: disabling, updating or
			// uninstalling the extension invalidates us, but the worklet module is already
			// loaded and keeps processing. Stand it down so the video doesn't stay
			// transposed (and time-stretched) until a reload.
			postApply(NO_OP, lastQuality)
		})

		scheduleApply('startup')
	},
})
