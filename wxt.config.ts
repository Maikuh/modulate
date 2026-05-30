import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Modulate',
    description: 'Transpose YouTube video audio in semitones, per video.',
    permissions: ['storage'],
    web_accessible_resources: [
      {
        resources: ['soundtouch-processor.js', 'injected.js'],
        matches: ['*://*.youtube.com/*'],
      },
    ],
  },
});
