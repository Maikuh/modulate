/**
 * Extract the YouTube video ID from a URL.
 *
 * Handles standard watch URLs (`youtube.com/watch?v=ID`). Returns `null` when
 * the URL is not a watch page (e.g. the home feed, channel pages, Shorts), in
 * which case there is no per-video setting to apply.
 */
export function getVideoId(url: string): string | null {
	try {
		const u = new URL(url)
		if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null
		return u.searchParams.get('v')
	} catch {
		return null
	}
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
	const current = flexy?.getAttribute('video-id')
	if (expectedId && current && current !== expectedId) return null

	const h1 = flexy
		?.querySelector<HTMLElement>('ytd-watch-metadata h1, #title h1')
		?.textContent?.trim()
	if (h1) return h1

	const meta = document.querySelector<HTMLMetaElement>('meta[name="title"]')?.content?.trim()
	if (meta) return meta

	const fromTitle = document.title
		.replace(/^\(\d+\)\s*/, '')
		.replace(/\s*-\s*YouTube\s*$/, '')
		.trim()
	return fromTitle || null
}
