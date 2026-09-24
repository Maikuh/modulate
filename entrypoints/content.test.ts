import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { ContentScriptContext } from 'wxt/utils/content-script-context'

import { DEFAULT_AUDIO_QUALITY } from '@/lib/audioQuality'
import type { ApplyMessage, PlayerState, PopupMessage } from '@/lib/messaging'
import { globalEnabled, setVideoSetting, getRawVideoSetting } from '@/lib/storage'

import content from './content'

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
async function startContentScript() {
	const ctx = new ContentScriptContext('test')
	const posted: string[] = []
	const onPost = (e: MessageEvent) => {
		if (typeof e.data === 'string') posted.push(e.data)
	}
	window.addEventListener('message', onPost)

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
	injectedEl.dispatchEvent(new Event('load'))

	await tick()
	return {
		ctx,
		/** Every `ApplyMessage` posted to the page realm, parsed. */
		applies: () => posted.map((raw) => JSON.parse(raw) as ApplyMessage),
		/** Raw payloads, to assert on the wire format itself. */
		raw: () => [...posted],
		/** Clear both the posted payloads and the badge-message spy. */
		reset: () => {
			posted.length = 0
			vi.mocked(browser.runtime.sendMessage).mockClear()
		},
		stop: () => {
			window.removeEventListener('message', onPost)
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
	return new Promise<PlayerState>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no response to ${msg.type}`)), 1000)
		// `trigger` is typed for the two-arg (message, sender) shape, but it spreads
		// whatever it is given straight into the listeners — which take a third
		// `sendResponse` argument, the one carrying the reply.
		const trigger = fakeBrowser.runtime.onMessage.trigger as (
			...args: unknown[]
		) => Promise<unknown>
		void trigger(msg, {}, (state: PlayerState) => {
			clearTimeout(timer)
			resolve(state)
		})
	}).then(async (state) => {
		await tick()
		return state
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

	it('carries the resolved settings, the worklet URL and the quality knobs', async () => {
		await setVideoSetting('vid1', { semitones: -2, tempo: 1.5 })
		const cs = await startContentScript()

		expect(cs.applies().at(-1)).toEqual({
			source: 'modulate',
			type: 'apply',
			processorUrl: expect.stringContaining('soundtouch-processor.js'),
			semitones: -2,
			tempo: 1.5,
			overlapMs: expect.any(Number),
			quickSeek: expect.any(Boolean),
		})
		cs.stop()
	})

	// A stored quality missing a field would otherwise drop that key from the JSON,
	// and the page-side parser rejects the whole message — every apply, forever.
	it('sends a complete quality payload even when storage holds a partial one', async () => {
		await fakeBrowser.storage.local.set({ audioQuality: { quickSeek: false } })
		await setVideoSetting('vid1', { semitones: 1 })
		const cs = await startContentScript()

		expect(cs.applies().at(-1)).toMatchObject({
			semitones: 1,
			overlapMs: DEFAULT_AUDIO_QUALITY.overlapMs,
			quickSeek: false,
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
})
