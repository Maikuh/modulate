import { defineWxtModule } from 'wxt/modules'

// Keep test files out of WXT's entrypoint discovery.
//
// WXT globs `entrypoints/*.ts` and derives an entrypoint name per file, so
// `entrypoints/content.test.ts` registers as a second entrypoint named "content"
// and the build fails with "Multiple entrypoints with the same name detected".
// (Specs nested inside a directory entrypoint — `entrypoints/popup/App.test.tsx`
// — are unaffected, which is why this only started mattering once the top-level
// content and injected scripts got specs.)
//
// `entrypoints:found` fires before WXT's duplicate-name check, so filtering here
// keeps the specs colocated with the code they cover rather than exiling them to
// a separate tests/ tree. Vitest picks them up from anywhere regardless.
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/

export default defineWxtModule((wxt) => {
	wxt.hooks.hook('entrypoints:found', (_, entrypointInfos) => {
		// Mutate in place: the hook's return value is ignored.
		const kept = entrypointInfos.filter((info) => !TEST_FILE.test(info.inputPath))
		entrypointInfos.splice(0, entrypointInfos.length, ...kept)
	})
})
