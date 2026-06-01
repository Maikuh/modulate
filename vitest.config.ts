import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

// See https://wxt.dev/guide/essentials/unit-testing
export default defineConfig({
	plugins: [WxtVitest()],
	test: {
		environment: 'happy-dom',
		setupFiles: ['./vitest.setup.ts'],
	},
})
