import { storage } from 'wxt/utils/storage';
import type {
  ApplyMessage,
  BadgeMessage,
  PopupMessage,
  PlayerState,
} from '@/lib/messaging';
import { getVideoId } from '@/lib/youtube';
import {
  globalEnabled,
  audioQuality,
  getRawVideoSetting,
  setVideoSetting,
  resolveSetting,
  clampSemitones,
  clampTempo,
  DEFAULT_VIDEO_SETTING,
} from '@/lib/storage';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  main(ctx) {
    // The worklet URL must be resolved here — the main-world script has no
    // access to extension APIs like `browser.runtime.getURL`.
    const processorUrl = browser.runtime.getURL('/soundtouch-processor.js');

    // Inject the audio engine into the page's MAIN world. It can't live in this
    // sandbox: Firefox throws DataCloneError when an AudioWorkletNode serializes
    // a sandbox object into the page-realm worklet. Load via `src` (not inline)
    // so YouTube's CSP doesn't block it.
    const injected = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('/injected.js');
      script.addEventListener('load', () => {
        script.remove();
        resolve();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error('failed to inject audio engine')), {
        once: true,
      });
      (document.head ?? document.documentElement).append(script);
    });
    injected.catch((err) => console.error('[modulate]', err));

    /** Read the state the popup needs to render the controls. */
    async function getState(): Promise<PlayerState> {
      const videoId = getVideoId(location.href);
      const global = await globalEnabled.getValue();
      const base: PlayerState = {
        videoId,
        globalEnabled: global,
        enabled: true,
        semitones: 0,
        tempo: 1,
      };
      if (!videoId) return base;

      const setting = await getRawVideoSetting(videoId);
      return {
        ...base,
        enabled: setting?.enabled ?? DEFAULT_VIDEO_SETTING.enabled,
        semitones: setting?.semitones ?? 0,
        tempo: setting?.tempo ?? 1,
      };
    }

    /** Resolve the effective pitch/tempo + quality and forward them to the engine. */
    async function apply(): Promise<void> {
      if (!ctx.isValid) return;
      const videoId = getVideoId(location.href);
      const global = await globalEnabled.getValue();
      const quality = await audioQuality.getValue();
      const video = videoId ? await getRawVideoSetting(videoId) : undefined;
      const resolved = resolveSetting(global, video);

      await injected; // Ensure the page-world listener is registered.
      if (!ctx.isValid) return;

      const msg: ApplyMessage = {
        source: 'modulate',
        type: 'apply',
        processorUrl,
        semitones: resolved.semitones,
        tempo: resolved.tempo,
        overlapMs: quality.overlapMs,
        quickSeek: quality.quickSeek,
        sequenceMs: quality.sequenceMs,
        seekWindowMs: quality.seekWindowMs,
      };
      // JSON string payload: primitives cross the content/page membrane without
      // `cloneInto`; a raw object would arrive as `null` in the page realm.
      window.postMessage(JSON.stringify(msg), '*');

      // Tell the background to render the toolbar badge for this tab.
      const badge: BadgeMessage = {
        type: 'MODULATE_BADGE',
        semitones: resolved.semitones,
        tempo: resolved.tempo,
      };
      browser.runtime.sendMessage(badge).catch(() => {});
    }

    async function handle(msg: PopupMessage): Promise<PlayerState> {
      const videoId = getVideoId(location.href);

      switch (msg.type) {
        case 'SET_SEMITONES':
          if (videoId) {
            await setVideoSetting(videoId, { semitones: clampSemitones(msg.semitones) });
          }
          break;
        case 'NUDGE_SEMITONES':
          if (videoId) {
            const current = await getRawVideoSetting(videoId);
            const from = current?.semitones ?? 0;
            await setVideoSetting(videoId, { semitones: clampSemitones(from + msg.delta) });
          }
          break;
        case 'SET_TEMPO':
          if (videoId) await setVideoSetting(videoId, { tempo: clampTempo(msg.tempo) });
          break;
        case 'NUDGE_TEMPO':
          if (videoId) {
            const current = await getRawVideoSetting(videoId);
            const from = current?.tempo ?? 1;
            await setVideoSetting(videoId, { tempo: clampTempo(from + msg.delta) });
          }
          break;
        case 'SET_VIDEO_ENABLED':
          if (videoId) await setVideoSetting(videoId, { enabled: msg.enabled });
          break;
        case 'SET_GLOBAL_ENABLED':
          await globalEnabled.setValue(msg.enabled);
          break;
        case 'RESET':
          if (videoId) await setVideoSetting(videoId, { ...DEFAULT_VIDEO_SETTING });
          break;
        case 'GET_STATE':
          break;
      }

      // GET_STATE is a pure read fired on popup mount — never touch the audio
      // graph, or the response would block on graph build / context resume.
      if (msg.type !== 'GET_STATE') {
        // A mutating message is a user gesture: (re)apply. Fire-and-forget so the
        // popup's response isn't held up by graph build or context resume.
        void apply().catch((err) => console.error('[modulate] apply failed', err));
      }
      return getState();
    }

    browser.runtime.onMessage.addListener(
      (msg: PopupMessage, _sender, sendResponse: (s: PlayerState) => void) => {
        handle(msg).then(sendResponse);
        return true; // keep the channel open for the async response
      },
    );

    // Re-apply on YouTube's SPA navigation (same element, new video ID).
    ctx.addEventListener(document, 'yt-navigate-finish', () => void apply());

    // Fallback: catch URL changes the event might miss.
    let lastUrl = location.href;
    ctx.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        void apply();
      }
    }, 1000);

    // Re-apply when settings change elsewhere (the options page edits storage
    // directly), so the active tab reflects edits live.
    const unwatchers = [
      storage.watch('local:videoSettings', () => void apply()),
      storage.watch('local:audioQuality', () => void apply()),
      storage.watch('local:globalEnabled', () => void apply()),
    ];
    ctx.onInvalidated(() => unwatchers.forEach((off) => off()));

    void apply();
  },
});
