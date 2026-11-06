import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defineWxtModule } from 'wxt/modules'

// Ship the Signalsmith Stretch AudioWorklet as our own web-accessible file.
//
// The package's file self-registers its processor when evaluated in a worklet
// scope, WASM embedded, so it goes out as-is — copied, not bundled. The page
// loads it with `audioWorklet.addModule(<extension URL>)` (see
// `lib/stretchNode.ts`); the package's own factory would load it from a Blob URL,
// which YouTube's CSP refuses.
const OUT = 'signalsmith-processor.js'

export default defineWxtModule((wxt) => {
	const src = createRequire(import.meta.url).resolve('signalsmith-stretch')

	wxt.hooks.hook('build:done', async (wxt, output) => {
		await copyFile(src, resolve(wxt.config.outDir, OUT))
		output.publicAssets.push({ type: 'asset', fileName: OUT })
	})

	// Register the copied file in WXT's `PublicPath` union so it type-checks with
	// `browser.runtime.getURL`.
	wxt.hooks.hook('prepare:publicPaths', (_, paths) => {
		paths.push(OUT)
	})
})
