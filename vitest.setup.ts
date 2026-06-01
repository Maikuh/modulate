import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/preact'
import { afterEach } from 'vitest'

// We import vitest globals explicitly (no `globals: true`), so @testing-library's
// auto-cleanup hook never registers. Unmount between cases ourselves, otherwise
// successive `render` calls pile up in document.body.
afterEach(() => cleanup())
