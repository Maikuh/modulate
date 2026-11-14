import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

// See https://wxt.dev/guide/essentials/unit-testing
export default defineConfig({
	plugins: [WxtVitest()],
	test: {
		environment: 'happy-dom',
		setupFiles: ['./vitest.setup.ts'],
		coverage: {
			provider: 'v8',
			include: ['{lib,entrypoints,components}/**/*.{ts,tsx}'],
			exclude: ['**/*.test.*', 'lib/testing/**', '**/main.tsx'],
			reporter: ['text-summary', 'text', 'html'],
		},
	},
})
