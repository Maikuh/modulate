import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defineWxtModule } from 'wxt/modules'

// SPIKE — ship the Signalsmith Stretch worklet as our own web-accessible file.
//
// The package's file self-registers its AudioWorkletProcessor when evaluated in a
// worklet scope, WASM embedded, so it goes out as-is: copied, not bundled. The
// page loads it with `audioWorklet.addModule(<extension URL>)` — the package's own
// default is a Blob URL, which YouTube's CSP refuses.
const OUT = 'signalsmith-processor.js'

export default defineWxtModule((wxt) => {
	const src = createRequire(import.meta.url).resolve('signalsmith-stretch')

	wxt.hooks.hook('build:done', async (wxt, output) => {
		await copyFile(src, resolve(wxt.config.outDir, OUT))
		output.publicAssets.push({ type: 'asset', fileName: OUT })
	})
})
