import { audioEngine } from '@/lib/audioEngine';
import type { ApplyMessage } from '@/lib/messaging';

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
    return document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
  }

  /** Resolve once a <video> exists, or null after a timeout. */
  function waitForVideo(timeoutMs = 10_000): Promise<HTMLVideoElement | null> {
    const existing = findVideo();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = findVideo();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(findVideo());
      }, timeoutMs);
    });
  }

  async function apply(msg: ApplyMessage): Promise<void> {
    const el = await waitForVideo();
    if (!el) return;
    await audioEngine.ensureGraph(el, msg.processorUrl);
    audioEngine.applySemitones(msg.semitones);
    // The originating popup click is a user gesture, so resuming here succeeds.
    await audioEngine.resume();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || typeof event.data !== 'string') return;

    let msg: ApplyMessage;
    try {
      const parsed = JSON.parse(event.data);
      if (parsed?.source !== 'modulate' || parsed.type !== 'apply') return;
      msg = parsed;
    } catch {
      return; // Not our message.
    }

    void apply(msg).catch((err) => console.error('[modulate] audio apply failed', err));
  });
});
