import { storage } from 'wxt/utils/storage';

/** Persisted transpose settings for a single video. */
export interface VideoSetting {
  /** Per-video enable toggle. */
  enabled: boolean;
  /** Pitch shift in semitones. */
  semitones: number;
  /** Playback rate (1 = original speed); pitch is held constant. */
  tempo: number;
}

export const DEFAULT_VIDEO_SETTING: VideoSetting = {
  enabled: true,
  semitones: 0,
  tempo: 1,
};

/** Range clamp for the semitone stepper (±12 = one octave). */
export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;

/** Range clamp for the tempo stepper. */
export const MIN_TEMPO = 0.5;
export const MAX_TEMPO = 2;
export const TEMPO_STEP = 0.05;

/** Clamp helpers — keep the same rounding everywhere a value is persisted. */
export function clampSemitones(n: number): number {
  return Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, Math.round(n)));
}

export function clampTempo(n: number): number {
  // Round to the step grid so float drift from repeated nudges can't accumulate.
  const snapped = Math.round(n / TEMPO_STEP) * TEMPO_STEP;
  return Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, Number(snapped.toFixed(2))));
}

/** WSOLA time-stretch tuning, applied to the SoundTouch worklet. `0` = auto-calc. */
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

/** Global master switch. When off, every video plays untransposed. */
export const globalEnabled = storage.defineItem<boolean>('local:globalEnabled', {
  fallback: true,
});

/** Map of videoId → settings. A single object keeps listing/migration simple. */
const videoSettings = storage.defineItem<Record<string, VideoSetting>>(
  'local:videoSettings',
  { fallback: {} },
);

/** WSOLA quality knobs, shared across all videos. */
export const audioQuality = storage.defineItem<AudioQuality>('local:audioQuality', {
  fallback: DEFAULT_AUDIO_QUALITY,
});

export async function getVideoSetting(videoId: string): Promise<VideoSetting> {
  const all = await videoSettings.getValue();
  return { ...DEFAULT_VIDEO_SETTING, ...all[videoId] };
}

/** Whether an explicit per-video entry exists (distinct from the merged default). */
export async function getRawVideoSetting(
  videoId: string,
): Promise<VideoSetting | undefined> {
  const all = await videoSettings.getValue();
  return all[videoId] ? { ...DEFAULT_VIDEO_SETTING, ...all[videoId] } : undefined;
}

export async function setVideoSetting(
  videoId: string,
  partial: Partial<VideoSetting>,
): Promise<VideoSetting> {
  const all = await videoSettings.getValue();
  const next: VideoSetting = {
    ...DEFAULT_VIDEO_SETTING,
    ...all[videoId],
    ...partial,
  };
  await videoSettings.setValue({ ...all, [videoId]: next });
  return next;
}

export async function listVideoSettings(): Promise<Record<string, VideoSetting>> {
  return videoSettings.getValue();
}

export async function removeVideoSetting(videoId: string): Promise<void> {
  const all = await videoSettings.getValue();
  if (!(videoId in all)) return;
  const { [videoId]: _, ...rest } = all;
  await videoSettings.setValue(rest);
}

export async function clearVideoSettings(): Promise<void> {
  await videoSettings.setValue({});
}

/** Resolved values actually applied to audio after layering all the toggles. */
export interface ResolvedSetting {
  semitones: number;
  tempo: number;
}

/**
 * Resolve the values actually applied to audio. An explicit per-video setting
 * applies; otherwise the no-op (0 / 1×). The global master switch and the
 * per-video `enabled` toggle gate everything — when either is off the result is
 * the no-op so the video plays untransposed.
 */
export function resolveSetting(
  global: boolean,
  video: VideoSetting | undefined,
): ResolvedSetting {
  if (!global) return { semitones: 0, tempo: 1 };
  if (video) {
    if (!video.enabled) return { semitones: 0, tempo: 1 };
    return { semitones: video.semitones, tempo: video.tempo };
  }
  return { semitones: 0, tempo: 1 };
}
