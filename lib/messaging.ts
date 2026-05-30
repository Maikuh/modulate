/**
 * Message protocol for the extension.
 *
 * Two hops: the popup is a thin remote that messages the content script
 * (`PopupMessage`), and the content script forwards the resolved semitone value
 * to the main-world audio engine (`ApplyMessage`). The content script owns
 * storage; the main-world script owns the Web Audio graph (see `injected.ts`).
 */

export type PopupMessage =
  | { type: 'GET_STATE' }
  | { type: 'SET_SEMITONES'; semitones: number }
  | { type: 'SET_VIDEO_ENABLED'; enabled: boolean }
  | { type: 'SET_GLOBAL_ENABLED'; enabled: boolean }
  | { type: 'RESET' };

/**
 * Command posted from the content script to the main-world `injected` script
 * via `window.postMessage` (serialized to JSON — see `injected.ts` for why).
 */
export interface ApplyMessage {
  source: 'modulate';
  type: 'apply';
  /** Extension URL of the worklet processor (main world can't call `getURL`). */
  processorUrl: string;
  /** Effective semitones to apply, already resolved against the toggles. */
  semitones: number;
}

/** Snapshot returned to the popup so it can render the current state. */
export interface PlayerState {
  /** `null` when the active tab is not on a watchable video. */
  videoId: string | null;
  globalEnabled: boolean;
  enabled: boolean;
  semitones: number;
}
