import { describe, it, expect } from 'vitest'

import { getVideoId } from '@/lib/youtube'

describe('getVideoId', () => {
	it('extracts the id from a watch URL', () => {
		expect(getVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
	})

	it('extracts the id from an m.youtube.com watch URL', () => {
		expect(getVideoId('https://m.youtube.com/watch?v=abc123')).toBe('abc123')
	})

	// getVideoId only recognises `?v=` watch URLs — Shorts and other paths have no
	// per-video setting to apply, so they resolve to null.
	it('returns null for shorts URLs', () => {
		expect(getVideoId('https://www.youtube.com/shorts/abc123')).toBeNull()
	})

	it('returns null for non-watch YouTube paths', () => {
		expect(getVideoId('https://www.youtube.com/feed/subscriptions')).toBeNull()
	})

	it('returns null for non-YouTube hosts', () => {
		expect(getVideoId('https://example.com/watch?v=abc')).toBeNull()
	})

	it('returns null for malformed URLs', () => {
		expect(getVideoId('not a url')).toBeNull()
	})

	// `searchParams.get` yields '' here, which is falsy for the write guards but
	// truthy for the `!= null` checks driving the toolbar icon and the popup's
	// on-a-video state — so the popup would render controls that silently do nothing.
	it('returns null (not an empty string) for a valueless v param', () => {
		expect(getVideoId('https://www.youtube.com/watch?v=')).toBeNull()
		expect(getVideoId('https://www.youtube.com/watch')).toBeNull()
	})
})
