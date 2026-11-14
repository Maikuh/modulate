import preact from '@preact/preset-vite'
import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
	modules: ['@wxt-dev/auto-icons'],
	vite: () => ({ plugins: [preact()] }),
	manifest: ({ browser }) => ({
		name: 'Modulate',
		description:
			'Transpose YouTube audio by semitones and change its speed without changing pitch, per video.',
		// `activeTab`: opening the popup grants it the active tab's URL (no install
		// warning), which tells a YouTube tab that predates an install or update — and
		// so has no content script yet — apart from a tab on another site.
		permissions: ['storage', 'activeTab'],
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
					id: '{3c1ab0b8-276b-4fb7-a0ad-08b79df38358}',
					data_collection_permissions: { required: ['none'] },
				},
			},
		}),
		// Extension commands are browser-wide: the key is taken on every site, not
		// only YouTube. So none of these may be a text-editing chord. Ctrl+Shift+Arrow
		// is select-by-word on Windows/Linux (Cmd+Shift+Arrow, select-to-line-end, on
		// a Mac, where Chrome maps `Ctrl` to Cmd), and Option+Shift+Arrow is
		// select-by-word on a Mac. Alt+Shift+Arrow edits nothing on Windows/Linux, and
		// on a Mac `MacCtrl` is the real Control key, where Control+Shift+Arrow is free.
		commands: {
			'modulate-pitch-up': {
				suggested_key: { default: 'Alt+Shift+Up', mac: 'MacCtrl+Shift+Up' },
				description: 'Raise pitch a semitone',
			},
			'modulate-pitch-down': {
				suggested_key: { default: 'Alt+Shift+Down', mac: 'MacCtrl+Shift+Down' },
				description: 'Lower pitch a semitone',
			},
			'modulate-tempo-up': {
				suggested_key: { default: 'Alt+Shift+Right', mac: 'MacCtrl+Shift+Right' },
				description: 'Speed up playback',
			},
			'modulate-tempo-down': {
				suggested_key: { default: 'Alt+Shift+Left', mac: 'MacCtrl+Shift+Left' },
				description: 'Slow down playback',
			},
		},
		web_accessible_resources: [
			{
				resources: ['signalsmith-processor.js', 'injected.js'],
				matches: ['*://*.youtube.com/*'],
			},
		],
	}),
})
