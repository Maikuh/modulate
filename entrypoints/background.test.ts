import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import type { BadgeMessage } from '@/lib/messaging'
import { TEMPO_STEP } from '@/lib/settings'

import background from './background'

/**
 * fakeBrowser defines unimplemented APIs as THROWING stubs rather than leaving
 * them undefined, so `browser.action.*` and `browser.commands.onCommand` have to
 * be replaced before the entrypoint registers anything against them.
 */
const action = {
	setIcon: vi.fn().mockResolvedValue(undefined),
	setBadgeText: vi.fn().mockResolvedValue(undefined),
	setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
}

let commandListener: ((command: string) => unknown) | undefined

function installStubs() {
	Object.defineProperty(browser, 'action', { value: action, configurable: true })
	Object.defineProperty(browser, 'commands', {
		value: {
			onCommand: {
				addListener: (fn: (command: string) => unknown) => (commandListener = fn),
			},
		},
		configurable: true,
	})
}

function badge(overrides: Partial<BadgeMessage> = {}): BadgeMessage {
	return { type: 'MODULATE_BADGE', onVideo: true, semitones: 0, tempo: 1, ...overrides }
}

/**
 * Deliver a BadgeMessage as a content script would. Pass `null` for "no sending
 * tab" — an explicit `undefined` would fall back to the default parameter.
 */
async function sendBadge(msg: BadgeMessage, tabId: number | null = 7) {
	const sender = (tabId === null ? {} : { tab: { id: tabId } }) as Parameters<
		typeof fakeBrowser.runtime.onMessage.trigger
	>[1]
	await fakeBrowser.runtime.onMessage.trigger(msg, sender)
}

const badgeText = () => action.setBadgeText.mock.calls.at(-1)?.[0]?.text
const iconDir = () => {
	const path = action.setIcon.mock.calls.at(-1)?.[0]?.path as Record<number, string> | undefined
	return path?.[16]?.split('/')[0]
}

beforeEach(() => {
	fakeBrowser.reset()
	vi.clearAllMocks()
	commandListener = undefined
	installStubs()
	background.main()
})

describe('background — badge text', () => {
	// The regression in ae501f8: a bare String() drops the sign on positives, which
	// is intentional, but a template or toFixed would reintroduce a leading +.
	it('renders a positive pitch without a plus', async () => {
		await sendBadge(badge({ semitones: 3 }))
		expect(badgeText()).toBe('3')
	})

	it('keeps the minus on a negative pitch', async () => {
		await sendBadge(badge({ semitones: -2 }))
		expect(badgeText()).toBe('-2')
	})

	// Tempo gets a glyph because the badge fits roughly four characters and "1.25"
	// leaves no room to signal what the number means.
	it('renders a glyph for a tempo-only change', async () => {
		await sendBadge(badge({ semitones: 0, tempo: 1.5 }))
		expect(badgeText()).toBe('♪')
	})

	it('prefers pitch over tempo when both are set', async () => {
		await sendBadge(badge({ semitones: 4, tempo: 1.5 }))
		expect(badgeText()).toBe('4')
	})

	it('clears the badge at the no-op', async () => {
		await sendBadge(badge({ semitones: 0, tempo: 1 }))
		expect(badgeText()).toBe('')
	})

	it('tints the badge', async () => {
		await sendBadge(badge({ semitones: 1 }))
		expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith(
			expect.objectContaining({ tabId: 7 }),
		)
	})
})

describe('background — toolbar icon', () => {
	it('uses the colored set on a watchable video', async () => {
		await sendBadge(badge({ onVideo: true }))
		expect(iconDir()).toBe('icons')
	})

	it('uses the grayscale set off a video', async () => {
		await sendBadge(badge({ onVideo: false }))
		expect(iconDir()).toBe('icons-disabled')
	})

	// A per-tab override outlives the content script, so leaving a colored YouTube
	// tab for another site would strand the colored icon.
	it('resets to grayscale on a full-document navigation', async () => {
		await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'loading' }, {} as never)
		expect(iconDir()).toBe('icons-disabled')
	})

	// YouTube's SPA navigations don't load a document; the content script's badge
	// message keeps the icon in sync while staying on YouTube. Resetting on
	// 'complete' would fight it.
	it('does not touch the icon when a navigation completes', async () => {
		await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'complete' }, {} as never)
		expect(action.setIcon).not.toHaveBeenCalled()
	})
})

describe('background — message guards', () => {
	it('ignores a message that is not a badge update', async () => {
		await fakeBrowser.runtime.onMessage.trigger({ type: 'SOMETHING_ELSE' }, {
			tab: { id: 7 },
		} as never)
		expect(action.setBadgeText).not.toHaveBeenCalled()
	})

	it('ignores a badge update with no sending tab', async () => {
		await sendBadge(badge({ semitones: 3 }), null)
		expect(action.setBadgeText).not.toHaveBeenCalled()
	})
})

describe('background — keyboard commands', () => {
	// fakeBrowser's tabs.query ignores `currentWindow`, so a created tab never
	// matches the entrypoint's query. Stub the lookup instead.
	beforeEach(() => {
		vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 42 }] as never)
	})

	it.each([
		['modulate-pitch-up', { type: 'NUDGE_SEMITONES', delta: 1 }],
		['modulate-pitch-down', { type: 'NUDGE_SEMITONES', delta: -1 }],
		['modulate-tempo-up', { type: 'NUDGE_TEMPO', delta: TEMPO_STEP }],
		['modulate-tempo-down', { type: 'NUDGE_TEMPO', delta: -TEMPO_STEP }],
	])('forwards %s to the active tab', async (command, expected) => {
		const send = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined)

		await commandListener?.(command)

		expect(send).toHaveBeenCalledWith(42, expected)
	})

	it('ignores an unrecognized command', async () => {
		const send = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined)
		await commandListener?.('not-a-command')
		expect(send).not.toHaveBeenCalled()
	})

	// A tab with no content script (not YouTube, or YouTube from before an
	// extension reload) rejects. That must not become an unhandled rejection.
	it('swallows a send failure without rejecting', async () => {
		vi.spyOn(browser.tabs, 'sendMessage').mockRejectedValue(new Error('no receiving end'))
		await expect(commandListener?.('modulate-pitch-up')).resolves.not.toThrow()
	})
})
