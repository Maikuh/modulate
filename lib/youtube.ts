/**
 * Whether `id` can be a YouTube video ID. Real IDs are 11 base64url characters;
 * the check is only as strict as storage needs: the ID becomes part of a storage
 * key and a URL, so nothing outside `[A-Za-z0-9_-]` gets through.
 */
export function isVideoId(id: unknown): id is string {
	return typeof id === 'string' && /^[\w-]{1,64}$/.test(id)
}

/**
 * Extract the YouTube video ID from a URL.
 *
 * Handles watch URLs (`/watch?v=ID`), Shorts (`/shorts/ID`) and live streams
 * (`/live/ID`). Returns `null` anywhere else (the home feed, channel pages,
 * search), where the URL names no video — though one may still be playing in
 * the miniplayer, which only the page can tell (see `content.ts`).
 */
export function getVideoId(url: string): string | null {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return null
	}
	if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null
	// `searchParams.get` hands back `''` for a valueless `?v=`, which would be falsy
	// for the `if (videoId)` write guards but truthy for the `videoId != null`
	// checks that drive the toolbar icon and the popup — controls whose every
	// action is silently dropped. `isVideoId` rejects it.
	const id =
		u.pathname === '/watch'
			? u.searchParams.get('v')
			: /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1]
	return isVideoId(id) ? id : null
}

/**
 * Read the current video's human-readable title from the watch-page DOM.
 *
 * Pass `expectedId` (the video the caller is about to save for) to guard
 * against stale reads: on SPA navigation the URL flips instantly but the DOM
 * title sources update a beat later, so saving right after a nav would tag the
 * new video with the previous one's title. When the watch element is still
 * showing a different video, every source below is stale, so we bail.
 *
 * Prefers the watch element's metadata `<h1>` (lives in the subtree we just
 * validated against `expectedId`), then the `<meta name="title">` tag, then
 * `document.title` with YouTube's `(unread-count) Title - YouTube` decoration
 * stripped. Returns `null` when no usable title is found (e.g. before the
 * metadata mounts on SPA nav).
 */
export function getVideoTitle(expectedId?: string | null): string | null {
	const flexy = document.querySelector('ytd-watch-flexy')
	// A hidden watch element (on Shorts, or behind the miniplayer) describes the last
	// watch page, not this one; so do the meta tags it keeps up to date. Only the
	// document title follows every page.
	if (!flexy?.hasAttribute('hidden')) {
		const current = flexy?.getAttribute('video-id')
		if (expectedId && current && current !== expectedId) return null

		const h1 = flexy
			?.querySelector<HTMLElement>('ytd-watch-metadata h1, #title h1')
			?.textContent?.trim()
		if (h1) return h1

		const meta = document.querySelector<HTMLMetaElement>('meta[name="title"]')?.content?.trim()
		if (meta) return meta
	}

	const fromTitle = document.title
		.replace(/^\(\d+\)\s*/, '')
		.replace(/\s*-\s*YouTube\s*$/, '')
		.trim()
	return fromTitle || null
}
