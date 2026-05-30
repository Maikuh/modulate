import { storage } from 'wxt/utils/storage';

/** Persisted transpose settings for a single video. */
export interface VideoSetting {
  /** Per-video enable toggle. */
  enabled: boolean;
  /** Pitch shift in semitones. */
  semitones: number;
}

export const DEFAULT_VIDEO_SETTING: VideoSetting = {
  enabled: true,
  semitones: 0,
};

/** Range clamp for the semitone stepper (±12 = one octave). */
export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;

/** Global master switch. When off, every video plays untransposed. */
export const globalEnabled = storage.defineItem<boolean>('local:globalEnabled', {
  fallback: true,
});

/** Map of videoId → settings. A single object keeps listing/migration simple. */
const videoSettings = storage.defineItem<Record<string, VideoSetting>>(
  'local:videoSettings',
  { fallback: {} },
);

export async function getVideoSetting(videoId: string): Promise<VideoSetting> {
  const all = await videoSettings.getValue();
  return { ...DEFAULT_VIDEO_SETTING, ...all[videoId] };
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

/**
 * Resolve the semitone value actually applied to audio, honoring both the
 * global master switch and the per-video toggle.
 */
export function effectiveSemitones(
  global: boolean,
  setting: VideoSetting,
): number {
  return global && setting.enabled ? setting.semitones : 0;
}
