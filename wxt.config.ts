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
