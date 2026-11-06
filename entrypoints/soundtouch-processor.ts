import { SoundTouchProcessorBase, STANDARD_PARAMETER_DESCRIPTORS } from '@soundtouchjs/worklet-base'

import { CUSHION_SECONDS, OutputCushion } from '@/lib/outputCushion'

/**
 * The AudioWorklet processor, loaded by `SoundTouchNode.register` from
 * `/soundtouch-processor.js` inside the page's AudioWorkletGlobalScope — no
 * `window`, no DOM, no extension APIs.
 *
 * It is the stock `@soundtouchjs/audio-worklet` processor plus an output cushion
 * (see `lib/outputCushion.ts`): the stock one zero-fills mid-stream whenever its
 * output FIFO comes up a frame short, which clicks constantly while transposing up.
 * It reuses the package's base class, so the DSP, the AudioParams and the port
 * protocol `SoundTouchNode` speaks all stay the dependency's.
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

// AudioWorkletGlobalScope globals (not in the DOM lib).
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: new (options?: any) => object): void

export default defineUnlistedScript(() => {
	class ModulateProcessor extends SoundTouchProcessorBase {
		static get parameterDescriptors() {
			return STANDARD_PARAMETER_DESCRIPTORS
		}

		private readonly cushion = new OutputCushion(Math.round(sampleRate * CUSHION_SECONDS))

		constructor(options?: AudioWorkletNodeOptions) {
			super('[modulate]', {
				sampleRate,
				sampleBufferType: options?.processorOptions?.sampleBufferType ?? 'circular',
				interpolationStrategy: SoundTouchProcessorBase.resolveStrategy(
					options?.processorOptions?.interpolationStrategy,
					'[modulate]',
				),
			})
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
