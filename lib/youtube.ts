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
 * Prefers the `<meta name="title">` tag (clean, no suffix). Falls back to the
 * watch metadata `<h1>`, then `document.title` with YouTube's
 * `(unread-count) Title - YouTube` decoration stripped. Returns `null` when no
 * usable title is found (e.g. before the metadata mounts on SPA nav).
 */
export function getVideoTitle(): string | null {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="title"]')?.content?.trim()
	if (meta) return meta

	const h1 = document
		.querySelector<HTMLElement>('ytd-watch-metadata h1, #title h1')
		?.textContent?.trim()
	if (h1) return h1

	const fromTitle = document.title
		.replace(/^\(\d+\)\s*/, '')
		.replace(/\s*-\s*YouTube\s*$/, '')
		.trim()
	return fromTitle || null
}
