// @vitest-environment node
import { expect, it } from 'vitest'

import { QUANTUM, SR, createStretch } from './signalsmithSim'

it('runs the real processor offline and shifts pitch', async () => {
	const s = await createStretch({}, 12)
	const inL = new Float32Array(QUANTUM)
	const out: number[] = []
	let t = 0
	for (let b = 0; b < (SR * 2) / QUANTUM; b++) {
		for (let i = 0; i < QUANTUM; i++, t++) inL[i] = 0.5 * Math.sin((2 * Math.PI * 330 * t) / SR)
		const [l] = s.process(inL, inL)
		out.push(...l)
	}
	const tail = out.slice(SR)
	let crossings = 0
	for (let i = 1; i < tail.length; i++) if (tail[i - 1]! < 0 && tail[i]! >= 0) crossings++
	expect((crossings * SR) / tail.length / 330).toBeCloseTo(2, 1)
	expect(s.latency).toBeGreaterThan(0)
})
