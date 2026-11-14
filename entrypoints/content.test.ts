import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { ContentScriptContext } from 'wxt/utils/content-script-context'

import {
	APPLY_EVENT,
	PLAYING_EVENT,
	STATUS_EVENT,
	type ApplyMessage,
	type PlayerState,
	type PopupMessage,
	type PopupResponse,
} from '@/lib/messaging'
import { TEMPO_STEP } from '@/lib/settings'
import { globalEnabled, setVideoSetting, getRawVideoSetting } from '@/lib/storage'

import content, { INVALIDATION_POLL_MS } from './content'

const WATCH_URL = 'https://www.youtube.com/watch?v=vid1'

/** happy-dom's URL control; not part of the standard Window type. */
const happyWindow = window as Window & {
	happyDOM?: { setURL?: (url: string) => void }
}

function setUrl(url: string): void {
	happyWindow.happyDOM?.setURL?.(url)
}

/**
 * Boot the content script the way the browser would, and settle the injection
 * promise by hand.
 *
 * Two things fight us here. `apply()` blocks on a promise that resolves from a
 * `load` event on the injected `<script>`, so nothing proceeds until we fire it.
 * And a real `<script>` element makes happy-dom attempt the fetch and dispatch
 * `error` first — rejecting the promise before we can help. So swap in a plain
 * element for the injection: `main` only sets `.src`, adds listeners, appends
 * and removes, none of which need script semantics.
 */
async function startContentScript({ injection = 'load' }: { injection?: 'load' | 'error' } = {}) {
	const ctx = new ContentScriptContext('test')
	const posted: string[] = []
	// Anything on the page-wide channel would be readable by every page script.
	// (WXT's own context posts an object there to detect duplicate scripts; ours
	// were always JSON strings.)
	const broadcast: unknown[] = []
	const onBroadcast = (e: MessageEvent) => {
		if (typeof e.data === 'string') broadcast.push(e.data)
	}
	window.addEventListener('message', onBroadcast)

	let injectedEl: HTMLElement | undefined
	const createElement = document.createElement.bind(document)
	const spy = vi
		.spyOn(document, 'createElement')
		.mockImplementation((tag: string, ...rest: unknown[]) => {
			if (tag !== 'script') return createElement(tag, ...(rest as []))
			injectedEl = createElement('div')
			return injectedEl
		})

	content.main(ctx)
	spy.mockRestore()

	if (!injectedEl) throw new Error('content script did not inject')
	const channel = injectedEl
	channel.addEventListener(APPLY_EVENT, (e) => {
		const detail = (e as CustomEvent<unknown>).detail
		posted.push(detail as string)
	})
	channel.dispatchEvent(new Event(injection))

	await tick()
	return {
		ctx,
		/** The private channel: the injected `<script>` element. */
		channel,
		/** Every `ApplyMessage` sent to the page realm, parsed. */
		applies: () => posted.map((raw) => JSON.parse(raw) as ApplyMessage),
		/** Raw payloads, to assert on the wire format itself. */
		raw: () => [...posted],
		/** What was posted page-wide with `window.postMessage`. */
		broadcast: () => [...broadcast],
		/** Report a status from the page engine over the channel. */
		status: (status: string) =>
			channel.dispatchEvent(
				new CustomEvent(STATUS_EVENT, {
					detail: JSON.stringify({ source: 'modulate-page', type: 'status', status }),
				}),
			),
		/** Report, as the page does, which video the main player holds. */
		playing: (videoId: unknown, title: string | null = null) =>
			channel.dispatchEvent(
				new CustomEvent(PLAYING_EVENT, {
					detail: JSON.stringify({ source: 'modulate-page', type: 'playing', videoId, title }),
				}),
			),
		/** Clear both the posted payloads and the badge-message spy. */
		reset: () => {
			posted.length = 0
			vi.mocked(browser.runtime.sendMessage).mockClear()
		},
		stop: () => {
			window.removeEventListener('message', onBroadcast)
			ctx.notifyInvalidated()
		},
	}
}

/** Let queued microtasks and happy-dom's async postMessage delivery run. */
async function tick(times = 6) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Drive a `PopupMessage` through the registered onMessage listener.
 *
 * `trigger` resolves to the listeners' return values — `[true]`, the
 * keep-the-channel-open flag — not to the reply. The reply arrives through the
 * `sendResponse` callback, exactly as it does for the real popup.
 */
function send(msg: PopupMessage): Promise<PlayerState> {
	return sendRaw(msg).then((res) => {
		if (!res.ok) throw new Error(`${msg.type} failed: ${res.error}`)
		return res.state
	})
}

/** Like `send`, but resolves to the raw reply, failures included. */
function sendRaw(msg: PopupMessage): Promise<PopupResponse> {
	return new Promise<PopupResponse>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no response to ${msg.type}`)), 1000)
		// `trigger` is typed for the two-arg (message, sender) shape, but it spreads
		// whatever it is given straight into the listeners — which take a third
		// `sendResponse` argument, the one carrying the reply.
		const trigger = fakeBrowser.runtime.onMessage.trigger as (
			...args: unknown[]
		) => Promise<unknown>
		void trigger(msg, {}, (res: PopupResponse) => {
			clearTimeout(timer)
			resolve(res)
		})
	}).then(async (res) => {
		await tick()
		return res
	})
}

describe('content script', () => {
	beforeEach(() => {
		fakeBrowser.reset()
		// fakeBrowser's runtime.sendMessage is a throwing stub, and it throws
		// SYNCHRONOUSLY — the `.catch` in apply() would never attach, so the error
		// would escape apply() rather than being handled. The badge path is not what
		// these tests are about.
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined)
		setUrl(WATCH_URL)
		document.body.innerHTML = ''
	})

	afterEach(() => {
		vi.restoreAllMocks()
		document.body.innerHTML = ''
	})

	// AGENTS.md calls this out twice: a raw object arrives as `null` in the page
	// realm on Firefox without `cloneInto`. Chrome structured-clones it fine, so a
	// refactor to `postMessage(msg, '*')` passes every manual check on Chrome and
	// silently breaks Firefox. This is the assertion manual testing cannot make.
	it('posts the apply payload as a JSON string, not an object', async () => {
		await setVideoSetting('vid1', { semitones: 3 })
		const cs = await startContentScript()

		const raw = cs.raw()
		expect(raw.length).toBeGreaterThan(0)
		for (const payload of raw) expect(typeof payload).toBe('string')
		expect(cs.applies().at(-1)).toMatchObject({
			source: 'modulate',
			type: 'apply',
			semitones: 3,
		})
		cs.stop()
	})

	// window.postMessage reaches every script in the page; the injected <script>
	// element is a channel only our two scripts hold.
	it('sends nothing page-wide', async () => {
		await setVideoSetting('vid1', { semitones: 3 })
		const cs = await startContentScript()
		await send({ type: 'NUDGE_SEMITONES', delta: 1 })

		expect(cs.applies().length).toBeGreaterThan(0)
		expect(cs.broadcast()).toEqual([])
		cs.stop()
	})

	// The URL is for page scripts from 1.4 and earlier, still running after a
	// Firefox update; they reject an apply without it.
	it('carries the resolved settings, and the worklet URL for older page scripts', async () => {
		await setVideoSetting('vid1', { semitones: -2, tempo: 1.5 })
		const cs = await startContentScript()

		expect(cs.applies().at(-1)).toEqual({
			source: 'modulate',
			type: 'apply',
			processorUrl: expect.stringContaining('signalsmith-processor.js'),
			semitones: -2,
			tempo: 1.5,
		})
		cs.stop()
	})

	// The loudest invariant in AGENTS.md, enforced by a single `if`. Hoisting
	// apply() above the switch would make the popup's mount request block on graph
	// build and context resume — the popup hangs on its loading dots.
	it('GET_STATE never touches the audio graph', async () => {
		await setVideoSetting('vid1', { semitones: 4 })
		const cs = await startContentScript()
		cs.reset()

		const state = await send({ type: 'GET_STATE' })

		expect(cs.applies()).toHaveLength(0)
		expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
		expect(state).toMatchObject({ videoId: 'vid1', semitones: 4 })
		cs.stop()
	})

	it('a mutating message does apply', async () => {
		const cs = await startContentScript()
		cs.reset()

		await send({ type: 'SET_SEMITONES', semitones: 5 })

		expect(cs.applies().at(-1)).toMatchObject({ semitones: 5 })
		cs.stop()
	})

	describe('message handling', () => {
		it('clamps a set beyond the range before persisting', async () => {
			const cs = await startContentScript()
			await send({ type: 'SET_SEMITONES', semitones: 99 })
			expect(await getRawVideoSetting('vid1')).toMatchObject({ semitones: 12 })
			cs.stop()
		})

		it('nudges from zero and creates an enabled entry', async () => {
			const cs = await startContentScript()
			const state = await send({ type: 'NUDGE_SEMITONES', delta: 2 })
			expect(state).toMatchObject({ semitones: 2, enabled: true })
			cs.stop()
		})

		// Key auto-repeat delivers these faster than a read-modify-write round trip.
		// Unserialized, every message in the burst reads the same starting value.
		it('does not lose concurrent nudges', async () => {
			const cs = await startContentScript()

			await Promise.all(
				Array.from({ length: 5 }, () => send({ type: 'NUDGE_SEMITONES', delta: 1 })),
			)
			await tick()

			expect(await getRawVideoSetting('vid1')).toMatchObject({ semitones: 5 })
			cs.stop()
		})

		it('does not lose concurrent tempo nudges', async () => {
			const cs = await startContentScript()

			await Promise.all(
				Array.from({ length: 4 }, () => send({ type: 'NUDGE_TEMPO', delta: TEMPO_STEP })),
			)

			expect(await getRawVideoSetting('vid1')).toMatchObject({ tempo: 1.2 })
			cs.stop()
		})

		// setVideoSetting rewrites the whole record, so two writes in flight together
		// (a popup slider racing a shortcut) used to lose one of the two changes.
		it('keeps both of two writes that arrive together', async () => {
			const cs = await startContentScript()

			await Promise.all([
				send({ type: 'SET_SEMITONES', semitones: 3 }),
				send({ type: 'SET_TEMPO', tempo: 1.5 }),
			])

			expect(await getRawVideoSetting('vid1')).toMatchObject({ semitones: 3, tempo: 1.5 })
			cs.stop()
		})

		// "Off for this video" must survive as a real entry, and apply the no-op.
		it('SET_VIDEO_ENABLED off applies the no-op but keeps the entry', async () => {
			await setVideoSetting('vid1', { semitones: 5 })
			const cs = await startContentScript()
			cs.reset()

			const state = await send({ type: 'SET_VIDEO_ENABLED', enabled: false })

			expect(state).toMatchObject({ enabled: false, semitones: 5 })
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			expect(await getRawVideoSetting('vid1')).toMatchObject({ enabled: false, semitones: 5 })
			cs.stop()
		})

		it('SET_TEMPO persists and applies', async () => {
			const cs = await startContentScript()
			cs.reset()

			await send({ type: 'SET_TEMPO', tempo: 1.5 })

			expect(await getRawVideoSetting('vid1')).toMatchObject({ tempo: 1.5 })
			expect(cs.applies().at(-1)).toMatchObject({ tempo: 1.5 })
			cs.stop()
		})

		it('RESET restores the defaults', async () => {
			await setVideoSetting('vid1', { semitones: 7, tempo: 1.5 })
			const cs = await startContentScript()
			const state = await send({ type: 'RESET' })
			expect(state).toMatchObject({ semitones: 0, tempo: 1 })
			cs.stop()
		})

		it('SET_GLOBAL_ENABLED writes the master switch and resolves to the no-op', async () => {
			await setVideoSetting('vid1', { semitones: 6 })
			const cs = await startContentScript()
			cs.reset()

			await send({ type: 'SET_GLOBAL_ENABLED', enabled: false })

			expect(await globalEnabled.getValue()).toBe(false)
			// The per-video entry survives; only what gets APPLIED changes.
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			expect(await getRawVideoSetting('vid1')).toMatchObject({ semitones: 6 })
			cs.stop()
		})

		// Defaults ("0 st, 1.00×") read as a reset; a failure has to look like one.
		it('answers a failed write with an error, not a default state', async () => {
			const cs = await startContentScript()
			vi.spyOn(console, 'error').mockImplementation(() => {})
			vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('quota'))

			const res = await sendRaw({ type: 'SET_SEMITONES', semitones: 5 })

			expect(res).toEqual({ ok: false, error: 'quota' })
			cs.stop()
		})

		it('answers an unknown message instead of applying for it', async () => {
			const cs = await startContentScript()
			cs.reset()
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

			const state = await send({ type: 'NOT_A_REAL_TYPE' } as unknown as PopupMessage)

			expect(state).toMatchObject({ videoId: 'vid1' })
			expect(cs.applies()).toHaveLength(0)
			expect(warn).toHaveBeenCalled()
			cs.stop()
		})
	})

	describe('off a watch page', () => {
		beforeEach(() => setUrl('https://www.youtube.com/feed/subscriptions'))

		it('reports no video and applies the no-op', async () => {
			const cs = await startContentScript()
			const state = await send({ type: 'GET_STATE' })

			expect(state.videoId).toBeNull()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			cs.stop()
		})

		it('drops a mutating message rather than writing under a null id', async () => {
			const cs = await startContentScript()
			await send({ type: 'SET_SEMITONES', semitones: 5 })
			expect(await getRawVideoSetting('vid1')).toBeUndefined()
			cs.stop()
		})
	})

	describe('re-apply triggers', () => {
		// This is how per-video settings follow the viewer between videos.
		it('re-applies on YouTube SPA navigation', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			await setVideoSetting('vid2', { semitones: -2 })
			const cs = await startContentScript()
			cs.reset()

			setUrl('https://www.youtube.com/watch?v=vid2')
			document.dispatchEvent(new Event('yt-navigate-finish'))
			await tick()

			expect(cs.applies().at(-1)).toMatchObject({ semitones: -2 })
			cs.stop()
		})

		it('catches a URL change the navigation event missed, once', async () => {
			await setVideoSetting('vid2', { semitones: 4 })
			vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
			try {
				const cs = await startContentScript()
				cs.reset()

				setUrl('https://www.youtube.com/watch?v=vid2')
				vi.advanceTimersByTime(1000)
				await tick()
				expect(cs.applies()).toHaveLength(1)
				expect(cs.applies()[0]).toMatchObject({ semitones: 4 })

				vi.advanceTimersByTime(3000)
				await tick()
				expect(cs.applies()).toHaveLength(1)
				cs.stop()
			} finally {
				vi.useRealTimers()
			}
		})

		// With the Navigation API, WXT fires the event from `navigate`, before the URL
		// commits: `location` still reads the page being left. happy-dom has no
		// Navigation API, so dispatch the event the way that path does.
		it('re-applies on a URL change announced before it commits', async () => {
			await setVideoSetting('vid2', { semitones: 4 })
			const add = vi.spyOn(window, 'addEventListener')
			const cs = await startContentScript()
			const eventName = add.mock.calls
				.map(([type]) => type)
				.find((type) => type.endsWith('wxt:locationchange'))
			add.mockRestore()
			expect(eventName).toBeDefined()
			cs.reset()

			const announce = (url: string) => {
				const event = Object.assign(new Event(eventName!), { newUrl: new URL(url) })
				window.dispatchEvent(event)
			}
			announce('https://www.youtube.com/watch?v=vid2')
			setUrl('https://www.youtube.com/watch?v=vid2') // the entry commits
			await tick()
			expect(cs.applies()).toHaveLength(1)
			expect(cs.applies()[0]).toMatchObject({ semitones: 4 })

			// Announcing the page already applied changes nothing.
			announce('https://www.youtube.com/watch?v=vid2')
			await tick()
			expect(cs.applies()).toHaveLength(1)
			cs.stop()
		})

		it('re-applies when the page comes back from the back/forward cache', async () => {
			const cs = await startContentScript()
			await setVideoSetting('vid1', { semitones: 6 }) // changed while it was away
			await tick()
			cs.reset()

			window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
			await tick()
			expect(cs.applies()).toHaveLength(0) // a first load: startup applied already

			window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
			await tick()
			expect(cs.applies()).toEqual([expect.objectContaining({ semitones: 6 })])
			cs.stop()
		})

		// The options page edits storage directly; this is its only path to playback.
		it('re-applies when storage changes elsewhere', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			const cs = await startContentScript()
			cs.reset()

			await globalEnabled.setValue(false)
			await tick()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			cs.stop()
		})

		it('re-applies when this video is edited elsewhere, and only then', async () => {
			const cs = await startContentScript()
			cs.reset()

			await setVideoSetting('other', { semitones: 5 })
			await tick()
			expect(cs.applies()).toHaveLength(0)

			await setVideoSetting('vid1', { semitones: 2 })
			await tick()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 2 })
			cs.stop()
		})

		// The page-realm engine outlives the content script: disabling or updating the
		// extension would otherwise leave the video transposed until a reload.
		it('stands the engine down when the extension context is invalidated', async () => {
			await setVideoSetting('vid1', { semitones: 3, tempo: 1.5 })
			const cs = await startContentScript()
			cs.reset()

			cs.ctx.notifyInvalidated()
			await tick()

			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			cs.reset()
			await globalEnabled.setValue(false)
			await tick()
			expect(cs.applies()).toHaveLength(0)
			cs.stop()
		})

		// Nothing tells a content script that its extension went away; WXT only finds
		// out when something checks. Without a check the video stays transposed until
		// the next navigation. (happy-dom has no Navigation API, so WXT's URL poll
		// would notice here too; in browsers with it, only our own poll does.)
		it('notices on its own that the extension went away', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
			const runtime = browser.runtime as { id?: string }
			const id = runtime.id
			try {
				const cs = await startContentScript()
				cs.reset()

				runtime.id = undefined // what an orphaned script sees
				vi.advanceTimersByTime(INVALIDATION_POLL_MS)
				await tick()

				expect(cs.ctx.isValid).toBe(false)
				expect(cs.applies()).toEqual([expect.objectContaining({ semitones: 0, tempo: 1 })])
				cs.stop()
			} finally {
				// Not restored by `fakeBrowser.reset()`.
				runtime.id = id
				vi.useRealTimers()
			}
		})

		it('stands the engine down even if removing a watcher throws', async () => {
			const cs = await startContentScript()
			cs.reset()
			vi.spyOn(browser.storage.onChanged, 'removeListener').mockImplementation(() => {
				throw new Error('Extension context invalidated.')
			})
			vi.spyOn(console, 'debug').mockImplementation(() => {})

			cs.ctx.notifyInvalidated()
			await tick()

			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
		})
	})

	describe('keyboard shortcuts', () => {
		const notice = () =>
			document.querySelector('modulate-toast')?.shadowRoot?.querySelector('[role="status"]')
				?.textContent

		afterEach(() => document.querySelector('modulate-toast')?.remove())

		it('shows what a shortcut changed on the page', async () => {
			const cs = await startContentScript()
			await send({ type: 'NUDGE_SEMITONES', delta: 1, fromShortcut: true })
			expect(notice()).toBe('Pitch +1 st')
			await send({ type: 'NUDGE_TEMPO', delta: TEMPO_STEP, fromShortcut: true })
			expect(notice()).toBe('Tempo 1.05×')
			cs.stop()
		})

		it('shows nothing for a change made in the popup', async () => {
			const cs = await startContentScript()
			await send({ type: 'NUDGE_SEMITONES', delta: 1 })
			expect(notice()).toBeUndefined()
			cs.stop()
		})

		// No controls are on screen to show a stored value moving while it is off.
		it('changes nothing while switched off, and says so', async () => {
			await setVideoSetting('vid1', { enabled: false, semitones: 2 })
			const cs = await startContentScript()

			await send({ type: 'NUDGE_SEMITONES', delta: 1, fromShortcut: true })
			expect(notice()).toBe('Modulate is off for this video')
			expect(await getRawVideoSetting('vid1')).toMatchObject({ semitones: 2 })

			await setVideoSetting('vid1', { enabled: true })
			await globalEnabled.setValue(false)
			await send({ type: 'NUDGE_TEMPO', delta: TEMPO_STEP, fromShortcut: true })
			expect(notice()).toBe('Modulate is off')
			expect(await getRawVideoSetting('vid1')).toMatchObject({ tempo: 1 })
			cs.stop()
		})

		it('says what to do off a video', async () => {
			setUrl('https://www.youtube.com/feed/subscriptions')
			const cs = await startContentScript()
			await send({ type: 'NUDGE_SEMITONES', delta: 1, fromShortcut: true })
			expect(notice()).toBe('Modulate: open a video to tune it')
			cs.stop()
		})
	})

	describe('Shorts and live', () => {
		it('applies the setting saved for a Short', async () => {
			setUrl('https://www.youtube.com/shorts/short1')
			await setVideoSetting('short1', { semitones: -2 })
			const cs = await startContentScript()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: -2 })
			expect(await send({ type: 'GET_STATE' })).toMatchObject({ videoId: 'short1' })
			cs.stop()
		})

		it('saves a change made on a live stream under its id', async () => {
			setUrl('https://www.youtube.com/live/live1')
			const cs = await startContentScript()
			await send({ type: 'NUDGE_SEMITONES', delta: 1 })
			expect(await getRawVideoSetting('live1')).toMatchObject({ semitones: 1 })
			cs.stop()
		})
	})

	// The miniplayer keeps playing over the feed, whose URL names no video.
	describe('miniplayer', () => {
		const FEED = 'https://www.youtube.com/'

		function miniplayer(open: boolean): void {
			let app = document.querySelector('ytd-app')
			if (!app) {
				app = document.createElement('ytd-app')
				document.body.append(app)
			}
			app.toggleAttribute('miniplayer-is-active', open)
		}

		beforeEach(async () => {
			setUrl(FEED)
			await setVideoSetting('mini1', { semitones: 2 })
			await setVideoSetting('mini2', { semitones: 5, tempo: 1.25 })
		})

		it("applies the miniplayer video's setting over the feed", async () => {
			miniplayer(true)
			const cs = await startContentScript()
			cs.reset()

			cs.playing('mini1', 'Mini one')
			await tick()

			expect(cs.applies().at(-1)).toMatchObject({ semitones: 2 })
			expect(await send({ type: 'GET_STATE' })).toMatchObject({ videoId: 'mini1', semitones: 2 })
			expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ onVideo: true, semitones: 2 }),
			)
			cs.stop()
		})

		it("saves a change made there under the miniplayer video, with the player's title", async () => {
			miniplayer(true)
			const cs = await startContentScript()
			cs.playing('mini1', 'Mini one')
			await tick()

			await send({ type: 'NUDGE_SEMITONES', delta: 1 })

			expect(await getRawVideoSetting('mini1')).toMatchObject({ semitones: 3, title: 'Mini one' })
			cs.stop()
		})

		// It autoplays the next video without a navigation.
		it('follows the miniplayer to the next video', async () => {
			miniplayer(true)
			const cs = await startContentScript()
			cs.playing('mini1')
			await tick()
			cs.reset()

			cs.playing('mini2')
			await tick()

			expect(cs.applies()).toEqual([expect.objectContaining({ semitones: 5, tempo: 1.25 })])
			cs.stop()
		})

		it('applies on opening it, and stands down on closing it', async () => {
			const cs = await startContentScript()
			cs.playing('mini1')
			await tick()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			cs.reset()

			miniplayer(true)
			await tick()
			expect(cs.applies()).toEqual([expect.objectContaining({ semitones: 2 })])

			// The player keeps the closed video's id; only the attribute says it's gone.
			miniplayer(false)
			await tick()
			expect(cs.applies().at(-1)).toMatchObject({ semitones: 0, tempo: 1 })
			expect(await send({ type: 'GET_STATE' })).toMatchObject({ videoId: null })
			cs.stop()
		})

		it('ignores a rewrite of the attribute that changes nothing', async () => {
			miniplayer(true)
			const cs = await startContentScript()
			cs.playing('mini1')
			await tick()
			cs.reset()

			document.querySelector('ytd-app')!.setAttribute('miniplayer-is-active', '')
			await tick()

			expect(cs.applies()).toHaveLength(0)
			cs.stop()
		})

		it('lets the URL win on a watch page', async () => {
			setUrl(WATCH_URL)
			miniplayer(true)
			const cs = await startContentScript()
			cs.playing('mini1')
			await tick()
			expect(await send({ type: 'GET_STATE' })).toMatchObject({ videoId: 'vid1' })
			cs.stop()
		})

		// Anything in the page can post one; the id becomes a storage key.
		it('ignores a reported id no video could have', async () => {
			miniplayer(true)
			const cs = await startContentScript()
			cs.playing('../globalEnabled')
			cs.playing(42)
			await tick()
			expect(await send({ type: 'GET_STATE' })).toMatchObject({ videoId: null })
			cs.stop()
		})
	})

	describe('toolbar badge', () => {
		it('reports the effective settings for the tab', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			const cs = await startContentScript()

			expect(browser.runtime.sendMessage).toHaveBeenLastCalledWith({
				type: 'MODULATE_BADGE',
				onVideo: true,
				semitones: 3,
				tempo: 1,
				status: 'idle',
				audioSeq: 0,
			})
			cs.stop()
		})

		// The engine answers each apply asynchronously; the badge must follow it, or
		// it keeps advertising a transpose the page never started.
		it('re-sends the badge when the page engine reports back', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			const cs = await startContentScript()

			cs.status('waiting-for-gesture')
			await tick()

			expect(browser.runtime.sendMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({ semitones: 3, status: 'waiting-for-gesture', audioSeq: 1 }),
			)
			expect(await send({ type: 'GET_STATE' })).toMatchObject({
				audio: 'waiting-for-gesture',
				audioSeq: 1,
			})
			cs.stop()
		})

		// The failure is reported as a status, but the status only reaches the
		// toolbar riding on a badge — and no apply ever got far enough to send one.
		it('flags an engine that never loaded', async () => {
			await setVideoSetting('vid1', { semitones: 3 })
			vi.spyOn(console, 'error').mockImplementation(() => {})
			const cs = await startContentScript({ injection: 'error' })

			expect(browser.runtime.sendMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({ onVideo: true, semitones: 3, status: 'error' }),
			)
			expect(cs.applies()).toHaveLength(0)
			cs.stop()
		})

		it('reports no video off a watch page', async () => {
			setUrl('https://www.youtube.com/feed/subscriptions')
			const cs = await startContentScript()

			expect(browser.runtime.sendMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({ type: 'MODULATE_BADGE', onVideo: false }),
			)
			cs.stop()
		})
	})
})
