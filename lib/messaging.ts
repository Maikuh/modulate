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
 * `BadgeMessage` from the content script). An open popup listens for the same
 * `BadgeMessage` to keep its engine status live.
 *
 * The content/page hop runs over the injected `<script>` element as a private
 * channel (`APPLY_EVENT` / `STATUS_EVENT` CustomEvents carrying JSON strings),
 * not `window.postMessage`, which every script in the page can read and forge.
 *
 * Imported by the MAIN-world bundle, so it must stay free of extension APIs
 * (it pulls only the side-effect-free `settings` and `youtube` modules).
 */

import { clampSemitones, clampTempo, type ResolvedSetting } from '@/lib/settings'
import { isVideoId } from '@/lib/youtube'

/**
 * `fromShortcut` marks a nudge sent by the background for a keyboard command:
 * the page shows what it did (the popup, when used, shows that itself), and a
 * nudge for a video or extension switched off changes nothing — there are no
 * visible controls to say the stored value moved.
 */
export type PopupMessage =
	| { type: 'GET_STATE' }
	| { type: 'SET_SEMITONES'; semitones: number }
	| { type: 'NUDGE_SEMITONES'; delta: number; fromShortcut?: boolean }
	| { type: 'SET_TEMPO'; tempo: number }
	| { type: 'NUDGE_TEMPO'; delta: number; fromShortcut?: boolean }
	| { type: 'SET_VIDEO_ENABLED'; enabled: boolean }
	| { type: 'SET_GLOBAL_ENABLED'; enabled: boolean }
	| { type: 'RESET' }

/**
 * What the page-realm engine made of the latest settings, reported back so the
 * popup and badge stop claiming success the page never achieved.
 *
 * - `idle`: nothing asked for, and no graph was built (lazy capture).
 * - `applied`: the settings are live (or bypassed at the no-op).
 * - `waiting-for-gesture`: queued until the page itself is clicked or typed in;
 *   the audio context can't start without that, and popup clicks don't count.
 * - `no-video`: no player element appeared on the page.
 * - `ad`: an ad is playing; it plays untouched, and the settings resume after it.
 * - `error`: the engine failed (worklet load, capture, routing).
 */
export type AudioStatus = 'idle' | 'applied' | 'waiting-for-gesture' | 'no-video' | 'ad' | 'error'

const AUDIO_STATUSES: readonly AudioStatus[] = [
	'idle',
	'applied',
	'waiting-for-gesture',
	'no-video',
	'ad',
	'error',
]

/** Sent from the content script to the background script to drive the toolbar badge. */
export interface BadgeMessage {
	type: 'MODULATE_BADGE'
	/** Whether the sending tab is on a watchable video (drives the toolbar icon). */
	onVideo: boolean
	/** Effective semitones currently applied in the sending tab. */
	semitones: number
	/** Effective tempo currently applied in the sending tab. */
	tempo: number
	/** What the page engine last reported for those settings. */
	status: AudioStatus
	/** Increments with every status change in the tab (see `PlayerState.audioSeq`). */
	audioSeq: number
}

/** CustomEvent (on the injected `<script>`) carrying an `ApplyMessage` JSON string. */
export const APPLY_EVENT = 'modulate:apply'
/** CustomEvent (on the injected `<script>`) carrying a `StatusMessage` JSON string. */
export const STATUS_EVENT = 'modulate:status'
/** CustomEvent (on the injected `<script>`) carrying a `PlayingMessage` JSON string. */
export const PLAYING_EVENT = 'modulate:playing'

/**
 * Command sent from the content script to the main-world `injected` script as the
 * `detail` of an `APPLY_EVENT`, serialized to JSON: a string crosses the
 * content/page membrane in every browser, an object arrives as `null` in Firefox
 * without `cloneInto` and in Chrome's isolated worlds.
 * Carries the effective pitch/tempo, already resolved against the toggles.
 *
 * The worklet's URL is not part of it: the page script resolves that beside its
 * own `<script src>`, so no message can point `audioWorklet.addModule` anywhere.
 * The content script still sends `processorUrl` on the wire, for page scripts
 * from 1.4 and earlier, which require it and keep running after a Firefox update
 * hands their page to the new content script; this parser ignores it.
 */
export type ApplyMessage = {
	source: 'modulate'
	type: 'apply'
} & ResolvedSetting

/**
 * Parse an inbound payload into an `ApplyMessage`, or null if it isn't one.
 *
 * Every field is checked, not just the discriminant. The private channel is not a
 * trust boundary on its own: the listener runs in the MAIN world, which we share
 * with YouTube's own scripts and any other extension injecting there, and the
 * channel element is briefly in the DOM — so a well-formed message can come from
 * something that isn't our content script.
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
	if (!isFiniteNumber(m.semitones)) return reject('semitones')
	if (!isFiniteNumber(m.tempo)) return reject('tempo')

	return {
		source: 'modulate',
		type: 'apply',
		semitones: clampSemitones(m.semitones),
		tempo: clampTempo(m.tempo),
	}
}

/**
 * Sent from the main-world `injected` script back to the content script after
 * each apply settles, as a `STATUS_EVENT` JSON string like `ApplyMessage`.
 */
export interface StatusMessage {
	source: 'modulate-page'
	type: 'status'
	status: AudioStatus
}

/**
 * Parse a `StatusMessage`, or null if it isn't one. Anything in the MAIN world
 * can post one, but a forged status only changes what the popup and badge say —
 * it never reaches storage or the audio graph.
 */
export function parseStatusMessage(raw: string): AudioStatus | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const m = parsed as Record<string, unknown>
	if (m.source !== 'modulate-page' || m.type !== 'status') return null
	return AUDIO_STATUSES.includes(m.status as AudioStatus) ? (m.status as AudioStatus) : null
}

/**
 * Sent from the main-world script to the content script: the video the page's
 * main player holds, read from YouTube's player API (MAIN world only). The URL
 * names the video on a watch page, but not in the miniplayer, which keeps playing
 * over the feed and autoplays the next video without a navigation.
 */
export interface PlayingMessage {
	source: 'modulate-page'
	type: 'playing'
	videoId: string
	title: string | null
}

/**
 * Parse a `PlayingMessage`, or null if it isn't one. Anything in the MAIN world
 * can post one, so the id is held to the shape `getVideoId` accepts: it becomes a
 * storage key. A forged one can only pick which of the viewer's own saved
 * settings the miniplayer gets, or where a change made there is saved.
 */
export function parsePlayingMessage(raw: string): { videoId: string; title: string | null } | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const m = parsed as Record<string, unknown>
	if (m.source !== 'modulate-page' || m.type !== 'playing' || !isVideoId(m.videoId)) return null
	const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim() : null
	return { videoId: m.videoId, title }
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
	/** What the page engine last reported (see `AudioStatus`). */
	audio: AudioStatus
	/**
	 * Increments with every change of `audio` in the tab. The page answers an apply
	 * after the popup's reply has left, so the popup takes later statuses from
	 * `BadgeMessage`s — and needs this to tell which of the two is newer.
	 */
	audioSeq: number
}

/**
 * The content script's reply to every `PopupMessage`. A failure is its own case
 * rather than a default-valued `PlayerState`: defaults read as "0 st, 1.00×",
 * indistinguishable from a reset, and would make a failed read look like one.
 */
export type PopupResponse = { ok: true; state: PlayerState } | { ok: false; error: string }

// The routine "nobody is listening" failures: a tab without our content script
// (not YouTube, or opened before an install/update), a tab that closed mid-flight,
// or this script outliving its extension.
const EXPECTED_DISCONNECT =
	/Receiving end does not exist|Could not establish connection|No tab with id|Invalid tab ID|Extension context invalidated/i

/** Whether a messaging failure just means no content script is listening. */
export function isNoReceiver(err: unknown): boolean {
	return EXPECTED_DISCONNECT.test(err instanceof Error ? err.message : String(err))
}

/**
 * Log a failed extension call: `debug` for the routine disconnect cases above,
 * which fire constantly and mean nothing, and `warn` for anything else — which
 * Chrome would otherwise hide behind its default-off verbose level.
 */
export function logSendFailure(what: string, err: unknown): void {
	if (isNoReceiver(err)) console.debug(`[modulate] ${what}`, err)
	else console.warn(`[modulate] ${what}`, err)
}
