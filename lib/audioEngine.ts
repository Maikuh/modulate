import { SoundTouchNode } from '@soundtouchjs/audio-worklet';

/**
 * Owns the Web Audio graph that pitch-shifts a single media element.
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
 *    graph wired and set semitones to 0 rather than disconnecting (which would
 *    mute the element).
 *  - An AudioContext starts `suspended`; it must be resumed from a user gesture.
 *
 * On YouTube the same `<video>` element persists across SPA navigations, so a
 * single graph built once serves every video; only the semitone value changes.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private node: SoundTouchNode | null = null;
  private element: HTMLMediaElement | null = null;
  private building: Promise<void> | null = null;
  private semitones = 0;

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
    // Smooth the WSOLA seams. `quickSeek: false` runs the full cross-correlation
    // search for each overlap-add splice instead of the fast approximation —
    // costlier but fewer transient artifacts. A wider `overlapMs` lengthens the
    // crossfade between splices, hiding the remaining discontinuities. Tradeoff is
    // CPU and a touch more smearing, both acceptable here (offline-style playback).
    node.setStretchParameters({ overlapMs: 12, quickSeek: false });
    const source = ctx.createMediaElementSource(el);

    this.ctx = ctx;
    this.node = node;
    this.source = source;
    this.element = el;
    this.route();
  }

  /**
   * Wire the source either straight to the speakers (transpose off) or through
   * the SoundTouch worklet (transpose on). Bypassing the worklet at 0 semitones
   * matters: `createMediaElementSource` is one-shot, so without a bypass every
   * video's audio runs through continuous WSOLA processing even when untransposed
   * — needless CPU/memory that builds up over a long session and can hang the tab.
   *
   * Either branch always reaches `destination`, so the element never goes silent
   * (the "never fully disconnect" rule). Reconnecting is cheap but causes a small
   * audible seam, so callers only re-route when crossing the on/off boundary.
   */
  private route(): void {
    if (!this.ctx || !this.source || !this.node) return;
    this.source.disconnect();
    this.node.disconnect();
    if (this.semitones === 0) {
      this.source.connect(this.ctx.destination);
    } else {
      this.node.pitchSemitones.value = this.semitones;
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination);
    }
  }

  /** Whether the graph has been built (the video is already captured). */
  get hasGraph(): boolean {
    return this.node !== null;
  }

  /** Apply pitch shift in semitones (tempo untouched — transpose only). */
  applySemitones(semitones: number): void {
    const crossedBypass = (this.semitones === 0) !== (semitones === 0);
    this.semitones = semitones;
    if (this.node) this.node.pitchSemitones.value = semitones;
    if (crossedBypass) this.route();
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
    const ctx = this.ctx;
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.element = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}

export const audioEngine = new AudioEngine();
