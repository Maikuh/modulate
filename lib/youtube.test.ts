import { describe, it, expect, afterEach } from 'vitest'

import { getVideoId, getVideoTitle } from '@/lib/youtube'

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

// Builds just enough of the watch page for getVideoTitle to read. `videoId` is
// what ytd-watch-flexy currently advertises, which is the staleness signal.
function mountWatchPage(opts: {
	videoId?: string | null
	h1?: string
	meta?: string
	documentTitle?: string
}): void {
	document.title = opts.documentTitle ?? ''
	const parts: string[] = []
	if (opts.meta !== undefined) parts.push(`<meta name="title" content="${opts.meta}">`)
	if (opts.videoId !== null) {
		const attr = opts.videoId === undefined ? '' : ` video-id="${opts.videoId}"`
		const h1 =
			opts.h1 === undefined ? '' : `<ytd-watch-metadata><h1>${opts.h1}</h1></ytd-watch-metadata>`
		parts.push(`<ytd-watch-flexy${attr}>${h1}</ytd-watch-flexy>`)
	}
	document.body.innerHTML = parts.join('')
}

describe('getVideoTitle', () => {
	afterEach(() => {
		document.body.innerHTML = ''
		document.title = ''
	})

	it('prefers the watch metadata h1', () => {
		mountWatchPage({ videoId: 'abc', h1: 'Real Title', meta: 'Meta Title' })
		expect(getVideoTitle('abc')).toBe('Real Title')
	})

	it('falls back to the meta tag when the h1 is absent', () => {
		mountWatchPage({ videoId: 'abc', meta: 'Meta Title' })
		expect(getVideoTitle('abc')).toBe('Meta Title')
	})

	it('falls back to document.title, stripping YouTube decoration', () => {
		mountWatchPage({ videoId: 'abc', documentTitle: '(12) Some Song - YouTube' })
		expect(getVideoTitle('abc')).toBe('Some Song')
	})

	// The regression in 7ba3ba6: on SPA nav the URL flips before the DOM catches
	// up, so saving right after a nav tagged the new video with the old title.
	it('returns null while the watch element still shows a different video', () => {
		mountWatchPage({ videoId: 'previous', h1: 'Previous Video', meta: 'Previous Video' })
		expect(getVideoTitle('current')).toBeNull()
	})

	it('reads the title when the watch element has caught up', () => {
		mountWatchPage({ videoId: 'current', h1: 'Current Video' })
		expect(getVideoTitle('current')).toBe('Current Video')
	})

	it('reads without an expectedId (no staleness check requested)', () => {
		mountWatchPage({ videoId: 'abc', h1: 'Any Title' })
		expect(getVideoTitle()).toBe('Any Title')
	})

	it('returns null when no source yields a title', () => {
		mountWatchPage({ videoId: 'abc' })
		expect(getVideoTitle('abc')).toBeNull()
	})

	it('returns null for a document title that is only YouTube decoration', () => {
		mountWatchPage({ videoId: 'abc', documentTitle: '- YouTube' })
		expect(getVideoTitle('abc')).toBeNull()
	})

	// Known gap, pinned so a change in behavior is deliberate: the staleness guard
	// needs ytd-watch-flexy to exist AND carry a video-id. Before it mounts there is
	// nothing to compare against, so document.title -- equally stale -- gets through.
	it('cannot detect staleness before the watch element mounts', () => {
		mountWatchPage({ videoId: null, documentTitle: 'Previous Video - YouTube' })
		expect(getVideoTitle('current')).toBe('Previous Video')
	})
})
