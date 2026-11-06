import { registerInterpolationStrategy, type SoundTouch } from '@soundtouchjs/core'
import { SoundTouchProcessorBase, STANDARD_PARAMETER_DESCRIPTORS } from '@soundtouchjs/worklet-base'

import { BANDLIMITED_STRATEGY_ID, bandlimitedKernel } from '@/lib/bandlimitedKernel'
import { CUSHION_SECONDS, OutputCushion } from '@/lib/outputCushion'
import { PacedPipe } from '@/lib/pacedPipe'

/**
 * The AudioWorklet processor, loaded by `SoundTouchNode.register` from
 * `/soundtouch-processor.js` inside the page's AudioWorkletGlobalScope — no
 * `window`, no DOM, no extension APIs.
 *
 * It is the stock `@soundtouchjs/audio-worklet` processor with three changes, all
 * against crackling while transposing up:
 *  - an output cushion (`lib/outputCushion.ts`): the stock one zero-fills
 *    mid-stream whenever its output FIFO comes up a frame short;
 *  - a paced pipeline (`lib/pacedPipe.ts`): the stock one converts a whole WSOLA
 *    window in one render quantum when shifting up, a CPU spike Firefox's worklet
 *    can't absorb; ours spreads that work across quanta;
 *  - a band-limited, table-driven interpolation kernel (`lib/bandlimitedKernel.ts`)
 *    in place of the stock Lanczos, which aliases when shifting up.
 * It reuses the package's base class and DSP stages, so the algorithms, the
 * AudioParams and the port protocol `SoundTouchNode` speaks stay the dependency's.
 *
 * Everything that touches worklet globals lives inside `main`: WXT imports
 * entrypoints at build time to read their options, where `AudioWorkletProcessor`
 * does not exist.
 */

/**
 * The name `SoundTouchNode` constructs (`PROCESSOR_NAME` in the package). Not
 * imported: the package's index also pulls `SoundTouchNode`, which extends
 * `AudioWorkletNode` — a global the worklet scope doesn't have. A spec pins the two
 * together.
 */
export const PROCESSOR_NAME = 'soundtouch-processor'

/** Frames per `process` call (fixed by the Web Audio spec). */
const RENDER_QUANTUM = 128

// AudioWorkletGlobalScope globals (not in the DOM lib).
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: new (options?: any) => object): void

export default defineUnlistedScript(() => {
	registerInterpolationStrategy({ id: BANDLIMITED_STRATEGY_ID, kernel: bandlimitedKernel })

	class ModulateProcessor extends SoundTouchProcessorBase {
		static get parameterDescriptors() {
			return STANDARD_PARAMETER_DESCRIPTORS
		}

		private readonly cushion: OutputCushion

		constructor(options?: AudioWorkletNodeOptions) {
			super('[modulate]', {
				sampleRate,
				// `SoundTouchNode` passes no strategy unless asked to; ours is the default.
				interpolationStrategy: SoundTouchProcessorBase.resolveStrategy(
					options?.processorOptions?.interpolationStrategy ?? BANDLIMITED_STRATEGY_ID,
					'[modulate]',
				),
			})
			// Replace the base's `SoundTouch` with the paced pipe, on the strategy it
			// resolved. The cast is the one seam: the base types `_pipe` as the full class,
			// and the pipe implements the members the base uses (checked by its `implements`).
			const hold = Math.round(sampleRate * CUSHION_SECONDS)
			this.cushion = new OutputCushion(hold)
			this._pipe = new PacedPipe(
				sampleRate,
				this._pipe.interpolationStrategy,
				hold + RENDER_QUANTUM,
			) as unknown as SoundTouch
		}

		protected override extractSamples(
			leftOutput: Float32Array,
			rightOutput: Float32Array,
			frameCount: number,
			_toExtract: number,
			parameters: Record<string, Float32Array>,
		) {
			const take = this.cushion.take(this._pipe.outputBuffer.frameCount, frameCount)
			return super.extractSamples(leftOutput, rightOutput, frameCount, take, parameters)
		}

		// The stock processor posts metrics every 100 quanta; nothing here reads them.
		protected onProcessComplete(): void {}
	}

	registerProcessor(PROCESSOR_NAME, ModulateProcessor)
})
