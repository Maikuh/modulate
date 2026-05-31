import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Modulate',
    description: 'Transpose YouTube video audio in semitones, per video.',
    permissions: ['storage'],
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
  },
});
