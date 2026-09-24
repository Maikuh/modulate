import { logSendFailure, type BadgeMessage, type PopupMessage } from '@/lib/messaging'
import { TEMPO_STEP, isNoOp } from '@/lib/settings'

/** Keyboard `commands` → the `PopupMessage` to send the active tab's content script. */
const COMMAND_MESSAGES: Record<string, PopupMessage> = {
	'modulate-pitch-up': { type: 'NUDGE_SEMITONES', delta: 1 },
	'modulate-pitch-down': { type: 'NUDGE_SEMITONES', delta: -1 },
	'modulate-tempo-up': { type: 'NUDGE_TEMPO', delta: TEMPO_STEP },
	'modulate-tempo-down': { type: 'NUDGE_TEMPO', delta: -TEMPO_STEP },
}

export default defineBackground(() => {
	// MV3 Chrome exposes `browser.action`; MV2 Firefox exposes `browserAction`.
	const action = browser.action ?? browser.browserAction
	const ACCENT = '#646cff'
	// Settings saved but not audible yet (waiting for a click in the page) or not at
	// all (engine failure): the badge still shows what is set, but muted.
	const INACTIVE = '#8a8a93'
	const ERROR = '#d93025'

	// Toolbar icon: colored on a watchable video, grayscale otherwise. The content
	// script is the authority on whether its tab holds a video — in MV3 the
	// `content_scripts` match grants no host permission to read `tab.url` from the
	// background, so we can't tell from the URL here. The grayscale set is built by
	// `modules/generate-disabled-icons.ts` and is the manifest's `default_icon`, so
	// untouched tabs (never on YouTube) start grayscale for free.
	const setIcon = (tabId: number | undefined, onVideo: boolean) => {
		if (tabId == null || !action) return
		const d = onVideo ? 'icons' : 'icons-disabled'
		const path = { 16: `${d}/16.png`, 32: `${d}/32.png`, 48: `${d}/48.png`, 128: `${d}/128.png` }
		// Rejects benignly when the tab closed mid-flight, but also when the grayscale
		// set is missing from the build — and that set is the manifest's `default_icon`,
		// so a silent failure there means no icon renders anywhere and nothing says why.
		action
			.setIcon({ tabId, path })
			?.catch?.((err: unknown) => logSendFailure('setIcon failed', err))
	}

	// A full-document navigation clears the per-tab icon override back to grayscale.
	// Without this, leaving a colored YouTube tab for another site would strand the
	// colored icon (the override persists; the content script is gone). YouTube's
	// own SPA navigations don't load a document, so the content script's badge
	// message — not this — keeps the icon in sync while staying on YouTube.
	browser.tabs.onUpdated.addListener((tabId, info) => {
		if (info.status === 'loading') setIcon(tabId, false)
	})

	// Keyboard shortcuts: forward to the active tab's content script.
	browser.commands?.onCommand.addListener(async (command) => {
		const msg = COMMAND_MESSAGES[command]
		if (!msg) return
		try {
			const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
			if (tab?.id == null) return
			await browser.tabs.sendMessage(tab.id, msg)
		} catch (err) {
			// Usually just "not a YouTube tab". But the same rejection covers a YouTube
			// tab that predates an extension install/reload and so has no content script
			// yet — there the shortcut appears broken and only a tab reload fixes it, so
			// don't swallow the distinction entirely.
			logSendFailure(`shortcut ${command} not delivered`, err)
		}
	})

	// Toolbar badge: the content script reports its effective pitch/tempo per apply.
	browser.runtime.onMessage.addListener((message: BadgeMessage, sender) => {
		if (message?.type !== 'MODULATE_BADGE') return
		const tabId = sender.tab?.id
		if (tabId == null || !action) return

		setIcon(tabId, message.onVideo)

		// Badge stays compact: negative pitch keeps its `-`, positive drops the `+`.
		// Tempo-only gets a glyph rather than the number — the badge fits roughly four
		// characters, and "1.25" leaves no room to also signal what it means.
		// A failed engine gets a "!" so the badge stops claiming a transpose that isn't
		// playing.
		const text = isNoOp(message)
			? ''
			: message.status === 'error'
				? '!'
				: message.semitones !== 0
					? String(message.semitones)
					: '♪'
		const color =
			message.status === 'error' ? ERROR : message.status === 'applied' ? ACCENT : INACTIVE
		// Both reject with "No tab with id" if the tab closed between the content
		// script's send and this handler; unhandled, that surfaces as a service-worker
		// error with no context.
		const onError = (err: unknown) => logSendFailure('badge update failed', err)
		action.setBadgeText({ tabId, text })?.catch?.(onError)
		action.setBadgeBackgroundColor?.({ tabId, color })?.catch?.(onError)
	})
})
