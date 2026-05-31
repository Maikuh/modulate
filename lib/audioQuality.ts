/**
 * WSOLA time-stretch tuning, applied to the SoundTouch worklet. `0` = auto-calc.
 *
 * Kept in a side-effect-free module (no `storage.defineItem`, no extension APIs)
 * so the MAIN-world injected bundle can import the defaults without pulling
 * `storage.ts` — which touches extension APIs unavailable in the page realm.
 */
export interface AudioQuality {
  overlapMs: number;
  quickSeek: boolean;
  sequenceMs: number;
  seekWindowMs: number;
}

/** Defaults mirror the values the audio engine used to hardcode. */
export const DEFAULT_AUDIO_QUALITY: AudioQuality = {
  overlapMs: 12,
  quickSeek: false,
  sequenceMs: 0,
  seekWindowMs: 0,
};
