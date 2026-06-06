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
 * `BackgroundMessage` from the content script).
 */

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
 */
export interface ApplyMessage {
	source: 'modulate'
	type: 'apply'
	/** Extension URL of the worklet processor (main world can't call `getURL`). */
	processorUrl: string
	/** Effective semitones to apply, already resolved against the toggles. */
	semitones: number
	/** Effective playback rate to apply (1 = original), pitch held constant. */
	tempo: number
	/** WSOLA time-stretch tuning for the worklet. */
	overlapMs: number
	quickSeek: boolean
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
