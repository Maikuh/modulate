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
    const ctx = new AudioContext();
    await SoundTouchNode.register(ctx, processorUrl);

    const node = new SoundTouchNode({ context: ctx });
    const source = ctx.createMediaElementSource(el);
    source.connect(node);
    node.connect(ctx.destination);

    this.ctx = ctx;
    this.node = node;
    this.source = source;
    this.element = el;
  }

  /** Apply pitch shift in semitones (tempo untouched — transpose only). */
  applySemitones(semitones: number): void {
    if (this.node) this.node.pitchSemitones.value = semitones;
  }

  /** Resume the context from a user gesture; harmless if already running. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
  }
}

export const audioEngine = new AudioEngine();
