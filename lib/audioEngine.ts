import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
// Type-only import: erased at build so the storage module (which touches
// extension APIs) is never pulled into the MAIN-world injected bundle.
import type { AudioQuality } from '@/lib/storage';

/** Local copy of the quality defaults; kept in sync with `storage.ts`. */
const DEFAULT_AUDIO_QUALITY: AudioQuality = {
  overlapMs: 12,
  quickSeek: false,
  sequenceMs: 0,
  seekWindowMs: 0,
};

/**
 * Owns the Web Audio graph that pitch-shifts and time-stretches a single media
 * element.
 *
 * This MUST run in the page's main world, not a content-script sandbox. The
 * `AudioWorkletNode` constructor serializes `processorOptions` into the worklet,
 * which lives in the page realm; Firefox cannot structured-clone a content-script
 * sandbox object across that membrane and throws `DataCloneError` (even for
 * string-only payloads). Running here, every object is page-realm and clones fine.
 *
 * Critical Web Audio constraints this encodes:
 *
 *  - `createMediaElementSource` may be called only ONCE per (element, context).
 *    After it runs, the element stops outputting to speakers directly — all
 *    audio flows through this graph. So when transpose is "off" we keep the
 *    graph wired and bypass it rather than disconnecting (which would mute the
 *    element).
 *  - An AudioContext starts `suspended`; it must be resumed from a user gesture.
 *
 * Tempo: slowing the video is done by setting the **element's** `playbackRate`
 * (which lowers pitch like a record), then mirroring that to the SoundTouch
 * `playbackRate` AudioParam so the worklet compensates pitch back to normal.
 * Transpose (`pitchSemitones`) stacks on top, independent of tempo.
 *
 * On YouTube the same `<video>` element persists across SPA navigations, so a
 * single graph built once serves every video; only the parameters change.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private node: SoundTouchNode | null = null;
  private element: HTMLMediaElement | null = null;
  private building: Promise<void> | null = null;
  private semitones = 0;
  private tempo = 1;
  private quality: AudioQuality = DEFAULT_AUDIO_QUALITY;

  /**
   * The graph is bypassed (source wired straight to speakers) at the no-op:
   * no transpose AND original speed. Bypassing matters because
   * `createMediaElementSource` is one-shot, so without it every video runs
   * through continuous WSOLA processing even when untouched — needless CPU.
   */
  private get bypassed(): boolean {
    return this.semitones === 0 && this.tempo === 1;
  }

  /** Build the graph for `el` if not already built. Idempotent and safe to await repeatedly. */
  async ensureGraph(el: HTMLMediaElement, processorUrl: string): Promise<void> {
    if (this.element === el && this.node) return;
    if (this.building) return this.building;

    this.building = this.build(el, processorUrl).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(el: HTMLMediaElement, processorUrl: string): Promise<void> {
    // YouTube sometimes swaps the <video> element (ads, miniplayer↔watch). A new
    // element falls past the ensureGraph guard into a rebuild — close the prior
    // context first, or each swap leaks an AudioContext. Browsers cap the number
    // of live contexts (~6 in Chrome); past the cap `new AudioContext()` throws
    // and audio dies. Closing also releases the old element back to direct output.
    await this.dispose();

    // 'playback' over the default 'interactive': a larger output buffer gives the
    // SoundTouch WSOLA pipeline more slack to fill each render quantum. At the tiny
    // interactive buffer the worklet sometimes can't produce a full block in time,
    // zero-fills the gap, and that gap is the audible click while transposing. We
    // don't need low latency — this is offline-style playback, not live monitoring.
    const ctx = new AudioContext({ latencyHint: 'playback' });
    await SoundTouchNode.register(ctx, processorUrl);

    const node = new SoundTouchNode({ context: ctx });
    // Apply the user-tunable WSOLA timing. `quickSeek: false` runs the full
    // cross-correlation search per overlap-add splice instead of the fast
    // approximation; a wider `overlapMs` lengthens the crossfade between splices,
    // hiding discontinuities. Tradeoff is CPU and a touch more smearing — exposed
    // in the options page so users can trade latency vs. artifacts.
    node.setStretchParameters(this.quality);
    const source = ctx.createMediaElementSource(el);

    this.ctx = ctx;
    this.node = node;
    this.source = source;
    this.element = el;
    this.route();
  }

  /**
   * Wire the source either straight to the speakers (bypass) or through the
   * SoundTouch worklet. Either branch always reaches `destination`, so the
   * element never goes silent (the "never fully disconnect" rule). Reconnecting
   * causes a small audible seam, so callers only re-route when crossing the
   * bypass boundary.
   */
  private route(): void {
    if (!this.ctx || !this.source || !this.node) return;
    this.source.disconnect();
    this.node.disconnect();
    if (this.bypassed) {
      // Restore native speed + pitch preservation; the worklet's params are moot
      // while disconnected.
      this.resetElementRate();
      this.source.connect(this.ctx.destination);
    } else {
      this.applyLive();
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination);
    }
  }

  /** Push the current params into the live graph without re-routing (no seam). */
  private applyLive(): void {
    if (!this.node) return;
    this.node.pitchSemitones.value = this.semitones;
    this.node.playbackRate.value = this.tempo;
    if (this.element) {
      // The worklet compensates pitch assuming the element does a RAW resample
      // (pitch drops with speed). Browsers default `preservesPitch = true`, which
      // would hold pitch in the element and make the worklet's compensation a
      // double-correction — speed would then shift pitch. Turn it off so the
      // element feeds the worklet the resampled signal its math expects.
      this.setPreservesPitch(false);
      this.element.playbackRate = this.tempo;
    }
  }

  /** Restore the element to native playback (pitch-preserving, normal speed). */
  private resetElementRate(): void {
    if (!this.element) return;
    this.element.playbackRate = 1;
    this.setPreservesPitch(true);
  }

  /** Set `preservesPitch` with the legacy vendor-prefixed fallbacks. */
  private setPreservesPitch(value: boolean): void {
    const el = this.element as
      | (HTMLMediaElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean })
      | null;
    if (!el) return;
    el.preservesPitch = value;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = value;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = value;
  }

  /** Whether the graph has been built (the video is already captured). */
  get hasGraph(): boolean {
    return this.node !== null;
  }

  /** Apply pitch shift in semitones (tempo untouched). */
  applySemitones(semitones: number): void {
    const was = this.bypassed;
    this.semitones = semitones;
    if (was !== this.bypassed) this.route();
    else this.applyLive();
  }

  /** Apply playback rate (1 = original); pitch is compensated by the worklet. */
  applyTempo(tempo: number): void {
    const was = this.bypassed;
    this.tempo = tempo;
    if (was !== this.bypassed) this.route();
    else this.applyLive();
  }

  /** Update the WSOLA tuning, live if the graph already exists. */
  applyQuality(quality: AudioQuality): void {
    this.quality = quality;
    this.node?.setStretchParameters(quality);
  }

  /** Resume the context from a user gesture; harmless if already running. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
  }

  /**
   * Tear down the graph and close the context. Closing reverts the captured
   * element to direct output, so audio survives. Used on element swap (above)
   * and on real page unload (frees the context, which otherwise blocks bfcache).
   */
  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.source?.disconnect();
    this.resetElementRate();
    const ctx = this.ctx;
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.element = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}

export const audioEngine = new AudioEngine();
