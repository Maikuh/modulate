import { describe, expect, it, vi } from 'vitest'

// Both packages evaluate `class extends <worklet global>` on import, and happy-dom
// has neither global; stub them so the real `PROCESSOR_NAME` exports can be read.
vi.stubGlobal('AudioWorkletNode', class {})
vi.stubGlobal('AudioWorkletProcessor', class {})

const { PROCESSOR_NAME: PACKAGE_NAME } = await import('@soundtouchjs/audio-worklet')
const { PROCESSOR_NAME } = await import('./soundtouch-processor')

describe('soundtouch-processor', () => {
	it('registers under the name SoundTouchNode constructs', () => {
		expect(PROCESSOR_NAME).toBe(PACKAGE_NAME)
	})
})
