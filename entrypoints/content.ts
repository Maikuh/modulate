import type { ApplyMessage, PopupMessage, PlayerState } from '@/lib/messaging';
import { getVideoId } from '@/lib/youtube';
import {
  globalEnabled,
  getVideoSetting,
  setVideoSetting,
  effectiveSemitones,
  DEFAULT_VIDEO_SETTING,
  MIN_SEMITONES,
  MAX_SEMITONES,
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
      if (!videoId) {
        return { videoId: null, globalEnabled: global, enabled: true, semitones: 0 };
      }
      const setting = await getVideoSetting(videoId);
      return {
        videoId,
        globalEnabled: global,
        enabled: setting.enabled,
        semitones: setting.semitones,
      };
    }

    /** Resolve the effective semitones and forward them to the main-world engine. */
    async function apply(): Promise<void> {
      if (!ctx.isValid) return;
      const videoId = getVideoId(location.href);
      const global = await globalEnabled.getValue();
      const setting = videoId ? await getVideoSetting(videoId) : DEFAULT_VIDEO_SETTING;

      await injected; // Ensure the page-world listener is registered.
      if (!ctx.isValid) return;

      const msg: ApplyMessage = {
        source: 'modulate',
        type: 'apply',
        processorUrl,
        semitones: effectiveSemitones(global, setting),
      };
      // JSON string payload: primitives cross the content/page membrane without
      // `cloneInto`; a raw object would arrive as `null` in the page realm.
      window.postMessage(JSON.stringify(msg), '*');
    }

    async function handle(msg: PopupMessage): Promise<PlayerState> {
      const videoId = getVideoId(location.href);

      switch (msg.type) {
        case 'SET_SEMITONES':
          if (videoId) {
            const clamped = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, msg.semitones));
            await setVideoSetting(videoId, { semitones: clamped });
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

    void apply();
  },
});
