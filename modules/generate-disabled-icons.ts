import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import sharp from 'sharp'
import { defineWxtModule } from 'wxt/modules'

// Generate a grayscale "disabled" icon set alongside the colored set that
// `@wxt-dev/auto-icons` produces from `assets/icon.png`. The background script
// swaps to these per tab when the tab isn't a YouTube watch page (see
// `entrypoints/background.ts`). Sized from `assets/icon-disabled.png` the same
// way auto-icons sizes the active icon, so neither set is committed as derived
// PNGs — only the two source images live in `assets/`.
//
// `sharp` is resolved transitively (it's an `@wxt-dev/auto-icons` dependency),
// matching that module's own usage.
const SIZES = [128, 48, 32, 16]
const DIR = 'icons-disabled'

export default defineWxtModule((wxt) => {
	const src = resolve(wxt.config.srcDir, 'assets/icon-disabled.png')

	wxt.hooks.hook('build:done', async (wxt, output) => {
		await mkdir(resolve(wxt.config.outDir, DIR), { recursive: true })
		for (const size of SIZES) {
			await sharp(src).resize(size).png().toFile(resolve(wxt.config.outDir, `${DIR}/${size}.png`))
			output.publicAssets.push({ type: 'asset', fileName: `${DIR}/${size}.png` })
		}
	})

	// Keep `browser.runtime.getURL('/icons-disabled/<size>.png')` typed — WXT
	// derives the `PublicPath` union from `public/`, which doesn't hold these.
	wxt.hooks.hook('prepare:publicPaths', (_, paths) => {
		for (const size of SIZES) paths.push(`${DIR}/${size}.png`)
	})
})
