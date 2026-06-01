import { audioEngine } from '@/lib/audioEngine'
import type { ApplyMessage } from '@/lib/messaging'

/**
 * Runs in the page's MAIN world (injected by the content script). Owns the Web
 * Audio graph, which cannot live in the content-script sandbox: Firefox throws
 * `DataCloneError` when an `AudioWorkletNode` serializes a sandbox-created
 * `processorOptions` object into the page-realm worklet.
 *
 * The content script can't reach the page realm directly either, so it forwards
 * the effective semitone value here via `window.postMessage`. The payload is a
 * JSON string — primitives cross the content/page membrane without `cloneInto`.
 */
export default defineUnlistedScript(() => {
	/** Find the player's media element (mounts late on first load). */
	function findVideo(): HTMLVideoElement | null {
		return document.querySelector<HTMLVideoElement>('video.html5-main-video, video')
	}

	/** Resolve once a <video> exists, or null after a timeout. */
	function waitForVideo(timeoutMs = 10_000): Promise<HTMLVideoElement | null> {
		const existing = findVideo()
		if (existing) return Promise.resolve(existing)

		return new Promise((resolve) => {
			const observer = new MutationObserver(() => {
				const el = findVideo()
				if (el) {
					observer.disconnect()
					resolve(el)
				}
			})
			observer.observe(document.documentElement, { childList: true, subtree: true })
			setTimeout(() => {
				observer.disconnect()
				resolve(findVideo())
			}, timeoutMs)
		})
	}

	// Latest apply held back while we wait for a user gesture (see below).
	let pending: ApplyMessage | null = null
	let gestureHooked = false

	/** Retry the pending apply once the page sees its first gesture. */
	function hookGesture(): void {
		if (gestureHooked) return
		gestureHooked = true
		const retry = () => {
			gestureHooked = false
			// Drop both listeners — the first gesture fires one; the sibling would
			// otherwise linger (and re-arming on a later defer would stack them).
			window.removeEventListener('pointerdown', retry, true)
			window.removeEventListener('keydown', retry, true)
			const msg = pending
			pending = null
			if (msg) void apply(msg).catch((err) => console.error('[modulate] audio apply failed', err))
		}
		window.addEventListener('pointerdown', retry, { capture: true })
		window.addEventListener('keydown', retry, { capture: true })
	}

	async function apply(msg: ApplyMessage): Promise<void> {
		// Lazy capture: leave the <video> untouched until a real change (transpose or
		// tempo) is asked for. `createMediaElementSource` is irreversible and reroutes
		// ALL audio through Web Audio — capturing for a no-op needlessly exposes normal
		// playback to any graph/worklet fault. Nothing to do here, so bail.
		if (msg.semitones === 0 && msg.tempo === 1 && !audioEngine.hasGraph) return

		// Defer the FIRST graph build until the page has user activation. Building
		// captures the element (irreversibly) and routes its audio through a context
		// that starts `suspended`; without activation `resume()` can't run, so the
		// captured element would play silently. This bites auto-applies — page load,
		// SPA nav, options-page edits — which carry no gesture, unlike a popup click.
		// When the activation API is unavailable (older Firefox) we can't tell, so we
		// fall through and build as before. Once a graph exists, re-applies are cheap.
		const ua = navigator.userActivation
		if (!audioEngine.hasGraph && ua && !ua.hasBeenActive) {
			pending = msg
			hookGesture()
			return
		}

		const el = await waitForVideo()
		if (!el) return
		// Set quality before the graph is built so `ensureGraph` constructs with it.
		audioEngine.applyQuality({
			overlapMs: msg.overlapMs,
			quickSeek: msg.quickSeek,
			sequenceMs: msg.sequenceMs,
			seekWindowMs: msg.seekWindowMs,
		})
		await audioEngine.ensureGraph(el, msg.processorUrl)
		audioEngine.applyTempo(msg.tempo)
		audioEngine.applySemitones(msg.semitones)
		// We only reach a graph build after user activation (popup click, or the
		// gesture gate above), so the context can resume here.
		await audioEngine.resume()
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window || typeof event.data !== 'string') return

		let msg: ApplyMessage
		try {
			const parsed = JSON.parse(event.data)
			if (parsed?.source !== 'modulate' || parsed.type !== 'apply') return
			msg = parsed
		} catch {
			return // Not our message.
		}

		void apply(msg).catch((err) => console.error('[modulate] audio apply failed', err))
	})

	// Close the AudioContext on real unload only. Skipping bfcache (`persisted`)
	// keeps the frozen graph intact for restore — and avoids re-capturing the same
	// <video> on the way back, which `createMediaElementSource` forbids.
	window.addEventListener('pagehide', (event) => {
		if (!event.persisted) void audioEngine.dispose()
	})
})
