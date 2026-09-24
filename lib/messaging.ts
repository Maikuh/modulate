/**
 * Message protocol for the extension.
 *
 * Two hops: the popup is a thin remote that messages the content script
 * (`PopupMessage`), and the content script forwards the resolved pitch/tempo
 * values to the main-world audio engine (`ApplyMessage`). The content script owns
 * storage; the main-world script owns the Web Audio graph (see `injected.ts`).
 *
 * A third actor, the background script, drives keyboard `commands` (sending
 * `PopupMessage`s to the active tab) and renders the toolbar badge (receiving a
 * `BadgeMessage` from the content script).
 *
 * Imported by the MAIN-world bundle, so it must stay free of extension APIs
 * (it pulls only the side-effect-free `settings` and `audioQuality` modules).
 */

import { clampOverlapMs, type AudioQuality } from '@/lib/audioQuality'
import { clampSemitones, clampTempo, type ResolvedSetting } from '@/lib/settings'

export type PopupMessage =
	| { type: 'GET_STATE' }
	| { type: 'SET_SEMITONES'; semitones: number }
	| { type: 'NUDGE_SEMITONES'; delta: number }
	| { type: 'SET_TEMPO'; tempo: number }
	| { type: 'NUDGE_TEMPO'; delta: number }
	| { type: 'SET_VIDEO_ENABLED'; enabled: boolean }
	| { type: 'SET_GLOBAL_ENABLED'; enabled: boolean }
	| { type: 'RESET' }

/** Sent from the content script to the background script to drive the toolbar badge. */
export interface BadgeMessage {
	type: 'MODULATE_BADGE'
	/** Whether the sending tab is on a watchable video (drives the toolbar icon). */
	onVideo: boolean
	/** Effective semitones currently applied in the sending tab. */
	semitones: number
	/** Effective tempo currently applied in the sending tab. */
	tempo: number
}

/**
 * Command posted from the content script to the main-world `injected` script
 * via `window.postMessage` (serialized to JSON — see `injected.ts` for why).
 * Carries the effective pitch/tempo (already resolved against the toggles) and
 * the WSOLA time-stretch tuning for the worklet.
 */
export type ApplyMessage = {
	source: 'modulate'
	type: 'apply'
	/** Extension URL of the worklet processor (main world can't call `getURL`). */
	processorUrl: string
} & ResolvedSetting &
	AudioQuality

/**
 * Parse an inbound payload into an `ApplyMessage`, or null if it isn't one.
 *
 * Every field is checked, not just the discriminant. `event.source === window`
 * is not a trust boundary here: the listener runs in the MAIN world, which we
 * share with YouTube's own scripts and any other extension injecting there, so
 * a well-formed message can come from something that isn't our content script.
 * `processorUrl` is the field that matters most — it goes straight to
 * `audioWorklet.addModule`, so it must be an extension URL and nothing else.
 *
 * Numbers are clamped onto the storage ranges as well as type-checked: an
 * out-of-range value (`tempo: 100`) would make the engine's restricted-float
 * writes throw, and the storage clamps never saw a message that did not come
 * from storage.
 */
export function parseApplyMessage(raw: string): ApplyMessage | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null // The page posts non-JSON strings constantly.
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const m = parsed as Record<string, unknown>
	if (m.source !== 'modulate' || m.type !== 'apply') return null

	// From here on the payload claims to be ours, so a rejection is worth a trace:
	// a version-skewed or malformed field would otherwise drop every apply unseen.
	const reject = (field: string): null => {
		console.warn(`[modulate] ignoring apply message with invalid ${field}`)
		return null
	}
	if (typeof m.processorUrl !== 'string' || !/^(chrome|moz)-extension:\/\//.test(m.processorUrl))
		return reject('processorUrl')
	if (!isFiniteNumber(m.semitones)) return reject('semitones')
	if (!isFiniteNumber(m.tempo)) return reject('tempo')
	if (!isFiniteNumber(m.overlapMs)) return reject('overlapMs')
	if (typeof m.quickSeek !== 'boolean') return reject('quickSeek')

	return {
		source: 'modulate',
		type: 'apply',
		processorUrl: m.processorUrl,
		semitones: clampSemitones(m.semitones),
		tempo: clampTempo(m.tempo),
		overlapMs: clampOverlapMs(m.overlapMs),
		quickSeek: m.quickSeek,
	}
}

/** Narrow to a finite number — rejects NaN, Infinity, strings and undefined. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/** Snapshot returned to the popup so it can render the current state. */
export interface PlayerState {
	/** `null` when the active tab is not on a watchable video. */
	videoId: string | null
	globalEnabled: boolean
	enabled: boolean
	semitones: number
	tempo: number
}
