import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { ApplyMessage } from '@/lib/messaging'

// The real engine needs an AudioContext, which happy-dom does not implement. These
// tests are about the MAIN-world script's own logic — what it decides to call, and
// when — so the engine is a spy surface.
vi.mock('@/lib/audioEngine', () => ({
	audioEngine: {
		hasGraph: false,
		running: true,
		ensureGraph: vi.fn().mockResolvedValue(undefined),
		applyQuality: vi.fn(),
		apply: vi.fn(),
		resume: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
	},
}))

import { audioEngine } from '@/lib/audioEngine'

import injected from './injected'

const engine = vi.mocked(audioEngine)
const PROCESSOR_URL = 'chrome-extension://abc123/soundtouch-processor.js'

function message(overrides: Partial<ApplyMessage> = {}): ApplyMessage {
	return {
		source: 'modulate',
		type: 'apply',
		processorUrl: PROCESSOR_URL,
		semitones: 0,
		tempo: 1,
		overlapMs: 12,
		quickSeek: true,
		...overrides,
	}
}

/**
 * Deliver a payload as the content script does — a JSON string from the page's
 * own window.
 *
 * Dispatched rather than `window.postMessage`d because happy-dom leaves
 * `event.source` null on a self-post, and the listener's first guard is
 * `event.source !== window`. Real browsers set it; the harness does not.
 */
async function post(msg: unknown): Promise<void> {
	const data = typeof msg === 'string' ? msg : JSON.stringify(msg)
	window.dispatchEvent(new MessageEvent('message', { data, source: window }))
	await tick()
}

async function tick(times = 6) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Boot the script, recording the window listeners it registers so they can be
 * torn down afterwards.
 *
 * Every `main()` call builds a fresh closure but adds another 'message' listener
 * to the same shared happy-dom window. Left in place, a later test's post would
 * drive every previous instance too and inflate the spy counts. The recording
 * stays on for the whole test, not just `main()`: the first-gesture retry
 * listeners are added later, from inside an apply, and would otherwise outlive
 * the test holding a stale instance.
 */
let teardown: Array<() => void> = []
let recording: { mockRestore(): void } | null = null
function start() {
	if (!recording) {
		const added = window.addEventListener.bind(window)
		recording = vi
			.spyOn(window, 'addEventListener')
			.mockImplementation((type, fn: EventListenerOrEventListenerObject, opts) => {
				teardown.push(() => window.removeEventListener(type, fn, opts))
				added(type, fn, opts)
			})
	}
	injected.main()
}

/** Put a player element on the page. */
function mountVideo(className = 'html5-main-video'): HTMLVideoElement {
	const el = document.createElement('video')
	el.className = className
	document.body.append(el)
	return el
}

beforeEach(() => {
	vi.clearAllMocks()
	engine.hasGraph = false
	engine.running = true
	// Like the real engine, a completed build means a graph exists. A hand-set flag
	// alone lets the tests describe states the script can never actually reach.
	engine.ensureGraph.mockImplementation(async () => {
		engine.hasGraph = true
	})
	document.body.innerHTML = ''
})

afterEach(() => {
	recording?.mockRestore()
	recording = null
	teardown.forEach((off) => off())
	teardown = []
	document.body.innerHTML = ''
})

describe('injected script — payload validation', () => {
	beforeEach(() => {
		// Rejected payloads that claim to be ours log a warning; keep the output clean.
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		mountVideo()
		start()
	})

	it('ignores a payload that is not ours', async () => {
		await post({ source: 'something-else', type: 'apply' })
		await post({ source: 'modulate', type: 'not-apply' })
		expect(engine.ensureGraph).not.toHaveBeenCalled()
	})

	it('ignores non-JSON strings without throwing', async () => {
		await post('this is not json')
		await post('{"broken":')
		expect(engine.ensureGraph).not.toHaveBeenCalled()
	})

	// processorUrl is handed to audioWorklet.addModule. The MAIN world is shared
	// with page scripts, so anything can post here — an off-origin URL would load
	// third-party code into the page's worklet scope.
	it('rejects a processorUrl that is not an extension URL', async () => {
		await post(message({ semitones: 3, processorUrl: 'https://evil.example/worklet.js' }))
		expect(engine.ensureGraph).not.toHaveBeenCalled()

		await post(message({ semitones: 3, processorUrl: PROCESSOR_URL }))
		expect(engine.ensureGraph).toHaveBeenCalledOnce()
	})

	it('rejects non-finite and non-numeric parameters', async () => {
		await post(message({ semitones: '3' as unknown as number }))
		await post(message({ semitones: 3, tempo: Number.NaN }))
		await post(message({ semitones: 3, overlapMs: null as unknown as number }))
		await post(message({ semitones: 3, quickSeek: 'yes' as unknown as boolean }))
		expect(engine.ensureGraph).not.toHaveBeenCalled()
	})
})

describe('injected script — lazy capture', () => {
	beforeEach(() => {
		mountVideo()
		start()
	})

	// createMediaElementSource is irreversible and routes ALL page audio through
	// the graph. A user with no settings must never have their <video> captured.
	it('never builds a graph for a no-op', async () => {
		await post(message({ semitones: 0, tempo: 1 }))
		expect(engine.ensureGraph).not.toHaveBeenCalled()
		expect(engine.apply).not.toHaveBeenCalled()
	})

	it('builds for a real pitch or tempo change', async () => {
		await post(message({ semitones: 2 }))
		expect(engine.ensureGraph).toHaveBeenCalledWith(expect.anything(), PROCESSOR_URL)
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ semitones: 2 }))
	})

	// Leaving a watch page for the feed resolves to a no-op. Re-resolving the
	// element there can match a feed hover-preview, and ensureGraph would take its
	// swap path: dispose the working context and capture the wrong <video>.
	it('bypasses an existing graph in place, without re-resolving the element', async () => {
		engine.hasGraph = true
		await post(message({ semitones: 0, tempo: 1 }))

		expect(engine.ensureGraph).not.toHaveBeenCalled()
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ tempo: 1 }))
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ semitones: 0 }))
	})
})

describe('injected script — element resolution', () => {
	// querySelector matches in tree order, so a selector LIST would return whichever
	// <video> comes first in the DOM rather than the player.
	it('prefers the player element over a video that precedes it', async () => {
		const preview = mountVideo('preview-video')
		const player = mountVideo('html5-main-video')
		expect(preview.compareDocumentPosition(player) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

		start()
		await post(message({ semitones: 1 }))

		expect(engine.ensureGraph).toHaveBeenCalledWith(player, PROCESSOR_URL)
	})

	it('falls back to any video when the player class is absent', async () => {
		const only = mountVideo('some-other-player')
		start()
		await post(message({ semitones: 1 }))
		expect(engine.ensureGraph).toHaveBeenCalledWith(only, PROCESSOR_URL)
	})
})

describe('injected script — media lifecycle replay', () => {
	let video: HTMLVideoElement

	beforeEach(async () => {
		video = mountVideo()
		start()
		await post(message({ semitones: 5, tempo: 1.5 }))
		engine.hasGraph = true
		vi.clearAllMocks()
	})

	// yt-navigate-finish fires before the media is ready, so without this the next
	// clip starts playing untransposed.
	it.each(['loadstart', 'emptied'])('replays the last settings on %s', async (type) => {
		video.dispatchEvent(new Event(type))
		await tick()

		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ semitones: 5 }))
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ tempo: 1.5 }))
	})

	it('does nothing on a media event before any settings have arrived', async () => {
		teardown.forEach((off) => off())
		teardown = []
		vi.clearAllMocks()
		const fresh = mountVideo()
		start()

		fresh.dispatchEvent(new Event('loadstart'))
		await tick()

		expect(engine.apply).not.toHaveBeenCalled()
	})

	describe('ratechange', () => {
		it('re-applies when YouTube diverges the rate from ours', async () => {
			video.playbackRate = 1 // YouTube reset it; we asked for 1.5
			video.dispatchEvent(new Event('ratechange'))
			await tick()

			expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ tempo: 1.5 }))
		})

		// This guard is what stops apply → playbackRate → ratechange → apply from
		// looping on the audio thread.
		it('ignores the ratechange our own tempo apply caused', async () => {
			video.playbackRate = 1.5 // already what we asked for
			video.dispatchEvent(new Event('ratechange'))
			await tick()

			expect(engine.apply).not.toHaveBeenCalled()
		})

		// At tempo 1 the engine hands playbackRate back to the page, so YouTube's own
		// speed menu owns it and we must not fight it.
		it('leaves the rate alone when our tempo is 1', async () => {
			await post(message({ semitones: 5, tempo: 1 }))
			vi.clearAllMocks()

			video.playbackRate = 2 // the viewer picked 2x in YouTube's menu
			video.dispatchEvent(new Event('ratechange'))
			await tick()

			expect(engine.apply).not.toHaveBeenCalled()
		})
	})

	// YouTube swaps the element for ads and the miniplayer. The listeners have to
	// move with it, and must not stay doubled up on the old one.
	it('moves the listeners when the element is swapped', async () => {
		const replacement = mountVideo()
		video.remove()
		await post(message({ semitones: 7, tempo: 1.25 }))
		vi.clearAllMocks()

		replacement.dispatchEvent(new Event('loadstart'))
		await tick()
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ semitones: 7 }))

		vi.clearAllMocks()
		video.dispatchEvent(new Event('loadstart'))
		await tick()
		expect(engine.apply).not.toHaveBeenCalled()
	})

	// One replay per event, however many applies preceded it. Note the DOM itself
	// dedupes repeat `addEventListener` calls with the same function reference, so
	// this pins the observable behavior rather than `trackVideo`'s early return.
	it('replays once per event, not once per apply', async () => {
		await post(message({ semitones: 3, tempo: 1.1 }))
		await post(message({ semitones: 4, tempo: 1.2 }))
		vi.clearAllMocks()

		video.dispatchEvent(new Event('loadstart'))
		await tick()

		expect(engine.apply).toHaveBeenCalledOnce()
	})
})

describe('injected script — user activation gate', () => {
	const activation = (hasBeenActive: boolean) => {
		Object.defineProperty(navigator, 'userActivation', {
			value: { hasBeenActive, isActive: hasBeenActive },
			configurable: true,
		})
	}

	afterEach(() => {
		// happy-dom has no userActivation of its own; remove the stub so the older-
		// Firefox fallthrough path is what other suites see.
		Reflect.deleteProperty(navigator, 'userActivation')
	})

	// Building under a suspended context captures the element and plays it silently,
	// which is unrecoverable — so the first build waits for a real gesture.
	it('queues the first build until the page has been interacted with', async () => {
		activation(false)
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		expect(engine.ensureGraph).not.toHaveBeenCalled()

		// The retry re-enters apply() and re-checks the gate, so the flag has to flip
		// with the gesture — as it does in a real browser, where a pointerdown grants
		// the document sticky activation. Without flipping it the apply would simply
		// re-queue, which is the correct behavior for a page still lacking activation.
		activation(true)
		window.dispatchEvent(new Event('pointerdown'))
		await tick()

		expect(engine.ensureGraph).toHaveBeenCalledOnce()
		expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ semitones: 4 }))
	})

	it('keeps queueing while the page still has no activation', async () => {
		activation(false)
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		window.dispatchEvent(new Event('pointerdown'))
		await tick()

		expect(engine.ensureGraph).not.toHaveBeenCalled()
	})

	it('builds immediately once the page has sticky activation', async () => {
		activation(true)
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		expect(engine.ensureGraph).toHaveBeenCalledOnce()
	})

	it('does not gate re-applies once a graph exists', async () => {
		activation(false)
		engine.hasGraph = true
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		expect(engine.ensureGraph).toHaveBeenCalledOnce()
	})
})

describe('injected script — latest settings win', () => {
	const activation = (hasBeenActive: boolean) => {
		Object.defineProperty(navigator, 'userActivation', {
			value: { hasBeenActive, isActive: hasBeenActive },
			configurable: true,
		})
	}

	afterEach(() => Reflect.deleteProperty(navigator, 'userActivation'))

	// Set +4 on an autoplaying page nobody clicked, press Reset, then click: the
	// click must apply the reset, not the change it replaced.
	it('does not replay a queued change the user has since reset', async () => {
		activation(false)
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		await post(message())
		activation(true)
		window.dispatchEvent(new Event('pointerdown'))
		await tick()

		expect(engine.ensureGraph).not.toHaveBeenCalled()
		expect(engine.apply).not.toHaveBeenCalledWith(expect.objectContaining({ semitones: 4 }))
	})

	it('applies the newest change on the first gesture', async () => {
		activation(false)
		mountVideo()
		start()

		await post(message({ semitones: 4 }))
		await post(message({ semitones: 6 }))
		activation(true)
		window.dispatchEvent(new Event('keydown'))
		await tick()

		expect(engine.apply).toHaveBeenCalledOnce()
		expect(engine.apply).toHaveBeenCalledWith({ semitones: 6, tempo: 1 })
	})

	// A reset arriving while the first build is still in flight used to return
	// early (no graph yet), and the older +4 then landed once the build finished.
	it('does not let an in-flight build apply settings that were since reset', async () => {
		mountVideo()
		start()
		let release!: () => void
		engine.ensureGraph.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = () => {
						engine.hasGraph = true
						resolve()
					}
				}),
		)

		await post(message({ semitones: 4 }))
		await post(message())
		release()
		await tick()

		expect(engine.apply).not.toHaveBeenCalledWith(expect.objectContaining({ semitones: 4 }))
		expect(engine.apply).toHaveBeenLastCalledWith({ semitones: 0, tempo: 1 })
	})

	it('runs one apply at a time and ends on the latest message', async () => {
		mountVideo()
		start()
		let release!: () => void
		engine.ensureGraph.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = () => {
						engine.hasGraph = true
						resolve()
					}
				}),
		)

		await post(message({ semitones: 1 }))
		await post(message({ semitones: 2 }))
		await post(message({ semitones: 3 }))
		release()
		await tick()

		expect(engine.apply).toHaveBeenCalledOnce()
		expect(engine.apply).toHaveBeenCalledWith({ semitones: 3, tempo: 1 })
	})
})

describe('injected script — waiting for the player', () => {
	it('applies once a late-mounting <video> appears', async () => {
		start()
		await post(message({ semitones: 2 }))
		expect(engine.ensureGraph).not.toHaveBeenCalled()

		const el = mountVideo()
		await tick()

		expect(engine.ensureGraph).toHaveBeenCalledWith(el, PROCESSOR_URL)
	})

	it('gives up with a warning when no <video> ever appears', async () => {
		vi.useFakeTimers()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			start()
			window.dispatchEvent(
				new MessageEvent('message', {
					data: JSON.stringify(message({ semitones: 2 })),
					source: window,
				}),
			)
			await vi.advanceTimersByTimeAsync(10_000)

			expect(warn).toHaveBeenCalledWith(expect.stringContaining('no <video> found'))
			expect(engine.ensureGraph).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('injected script — context that will not start', () => {
	// The older-Firefox fallthrough can build without activation; the captured
	// element then plays silently until a gesture lets the context resume.
	it('warns and retries on the next gesture', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		engine.running = false
		mountVideo()
		start()

		await post(message({ semitones: 3 }))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not resume'))

		engine.running = true
		vi.clearAllMocks()
		window.dispatchEvent(new Event('pointerdown'))
		await tick()

		expect(engine.resume).toHaveBeenCalled()
		expect(engine.apply).toHaveBeenCalledWith({ semitones: 3, tempo: 1 })
	})
})

describe('injected script — pagehide', () => {
	beforeEach(() => start())

	/** happy-dom's PageTransitionEvent ignores the `persisted` init field. */
	function pagehide(persisted: boolean): Event {
		const event = new Event('pagehide')
		Object.defineProperty(event, 'persisted', { value: persisted })
		return event
	}

	// Disposing into bfcache closes the context; on the way back the same <video>
	// cannot be captured again and stays muted.
	it('keeps the graph when the page enters bfcache', () => {
		window.dispatchEvent(pagehide(true))
		expect(engine.dispose).not.toHaveBeenCalled()
	})

	it('disposes the graph on a real unload', () => {
		window.dispatchEvent(pagehide(false))
		expect(engine.dispose).toHaveBeenCalledOnce()
	})
})
