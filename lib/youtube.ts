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
