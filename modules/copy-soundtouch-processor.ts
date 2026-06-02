import { createRequire } from 'node:module'

import { defineWxtModule } from 'wxt/modules'

// Copy the AudioWorklet processor straight out of the dependency into the build
// output as `soundtouch-processor.js`, instead of committing a generated copy in
// `public/`. Resolved via the package's `./processor` export so a dependency
// bump picks up the new processor automatically. The fixed filename keeps the
// static `web_accessible_resources` entry and `getURL('/soundtouch-processor.js')`
// in `content.ts` working unchanged.
//
// Note: importing the processor with Vite's `?url` doesn't fit here — WXT inlines
// it as a `data:` URI, which loads in YouTube's MAIN world and is subject to the
// page CSP that the `chrome-extension://` web-accessible file sidesteps.
const require = createRequire(import.meta.url)

const DEST = 'soundtouch-processor.js'

export default defineWxtModule((wxt) => {
	wxt.hooks.hook('build:publicAssets', (_, files) => {
		files.push({
			absoluteSrc: require.resolve('@soundtouchjs/audio-worklet/processor'),
			relativeDest: DEST,
		})
	})

	// Keep `browser.runtime.getURL('/soundtouch-processor.js')` typed — WXT derives
	// the `PublicPath` union from `public/`, which no longer holds this file.
	wxt.hooks.hook('prepare:publicPaths', (_, paths) => {
		paths.push(DEST)
	})
})
