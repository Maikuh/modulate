import preact from '@preact/preset-vite'
import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
	modules: ['@wxt-dev/auto-icons'],
	vite: () => ({ plugins: [preact()] }),
	manifest: ({ browser }) => ({
		name: 'Modulate',
		description: 'Transpose YouTube video audio in semitones, per video.',
		permissions: ['storage'],
		// Grayscale toolbar icon by default; the background script swaps in the
		// colored set per tab while on a video (see entrypoints/background.ts). The
		// disabled set is produced by modules/generate-disabled-icons.ts.
		action: {
			default_icon: {
				16: 'icons-disabled/16.png',
				32: 'icons-disabled/32.png',
				48: 'icons-disabled/48.png',
				128: 'icons-disabled/128.png',
			},
		},
		// Firefox (AMO) requires a data-collection disclosure. Modulate stores
		// settings only in local storage and transmits nothing → "none".
		...(browser === 'firefox' && {
			browser_specific_settings: {
				gecko: {
					id: 'modulate@maikuh',
					data_collection_permissions: { required: ['none'] },
				},
			},
		}),
		commands: {
			'modulate-pitch-up': {
				suggested_key: { default: 'Ctrl+Shift+Up' },
				description: 'Raise pitch a semitone',
			},
			'modulate-pitch-down': {
				suggested_key: { default: 'Ctrl+Shift+Down' },
				description: 'Lower pitch a semitone',
			},
			'modulate-tempo-up': {
				suggested_key: { default: 'Ctrl+Shift+Right' },
				description: 'Speed up playback',
			},
			'modulate-tempo-down': {
				suggested_key: { default: 'Ctrl+Shift+Left' },
				description: 'Slow down playback',
			},
		},
		web_accessible_resources: [
			{
				resources: ['soundtouch-processor.js', 'injected.js'],
				matches: ['*://*.youtube.com/*'],
			},
		],
	}),
})
