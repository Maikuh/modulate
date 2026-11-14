import { fireEvent, render, within, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import type { BadgeMessage, PlayerState, PopupMessage, PopupResponse } from '@/lib/messaging'

import App from './App'

const activeState: PlayerState = {
	videoId: 'abc',
	globalEnabled: true,
	enabled: true,
	semitones: 0,
	tempo: 1,
	audio: 'applied',
	audioSeq: 0,
}

/** The status update a content script sends the extension (tab 1 unless given). */
async function pushStatus(status: BadgeMessage['status'], audioSeq: number, tabId = 1) {
	const msg: BadgeMessage = {
		type: 'MODULATE_BADGE',
		onVideo: true,
		semitones: 3,
		tempo: 1,
		status,
		audioSeq,
	}
	// Listeners take a third `sendResponse`; the popup's never answers, so any will do.
	await fakeBrowser.runtime.onMessage.trigger(msg, { tab: { id: tabId } } as never, () => {})
}

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'

/**
 * Spy on tabs.query/sendMessage. sendMessage answers with the given state, or
 * rejects as a tab with no content script does when given `null`.
 */
function mockTabs(state: PlayerState | null, tab: { url?: string } = {}) {
	vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 1, ...tab }] as any)
	const sendMessage = vi
		.spyOn(browser.tabs, 'sendMessage')
		.mockImplementation((async () =>
			state === null
				? Promise.reject(new Error(NO_RECEIVER))
				: ({ ok: true, state } satisfies PopupResponse)) as any)
	return sendMessage
}

// Scope queries to this render's container; `render` appends to document.body.
function renderApp() {
	return within(render(<App />).container as HTMLElement)
}

beforeEach(() => {
	fakeBrowser.reset()
	vi.restoreAllMocks()
})

describe('popup App', () => {
	it('renders the player state after the mount GET_STATE', async () => {
		mockTabs(activeState)
		const view = renderApp()
		expect(await view.findByText('Pitch')).toBeInTheDocument()
		expect(view.getByText('Tempo')).toBeInTheDocument()
	})

	it('shows the empty state when no content script responds', async () => {
		mockTabs(null)
		const view = renderApp()
		expect(await view.findByText(/Open a YouTube video/i)).toBeInTheDocument()
	})

	it('shows the empty state when videoId is null', async () => {
		mockTabs({ ...activeState, videoId: null })
		const view = renderApp()
		expect(await view.findByText(/Open a YouTube video/i)).toBeInTheDocument()
	})

	it('dispatches NUDGE_SEMITONES on the pitch increase button', async () => {
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockClear()
		await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }))
		expect(sendMessage.mock.calls[0]![1] as PopupMessage).toEqual({
			type: 'NUDGE_SEMITONES',
			delta: 1,
		})
	})

	it('dispatches SET_GLOBAL_ENABLED from the master switch', async () => {
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockClear()
		await userEvent.click(view.getByLabelText('Master switch'))
		expect(sendMessage.mock.calls[0]![1] as PopupMessage).toEqual({
			type: 'SET_GLOBAL_ENABLED',
			enabled: false,
		})
	})

	it('dispatches RESET from the reset button', async () => {
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockClear()
		await userEvent.click(view.getByRole('button', { name: /reset/i }))
		await waitFor(() => expect(sendMessage).toHaveBeenCalled())
		expect(sendMessage.mock.calls[0]![1] as PopupMessage).toEqual({ type: 'RESET' })
	})

	describe('each control sends its message', () => {
		const tuned: PlayerState = { ...activeState, semitones: 3, tempo: 1.25 }

		async function setup() {
			const sendMessage = mockTabs(tuned)
			const view = renderApp()
			await view.findByText('Pitch')
			sendMessage.mockClear()
			const sent = () => sendMessage.mock.calls.map(([, msg]) => msg as PopupMessage)
			return { view, sent }
		}

		it('pitch and tempo sliders', async () => {
			const { view, sent } = await setup()
			fireEvent.input(view.getByRole('slider', { name: 'Pitch' }), { target: { value: '-4' } })
			fireEvent.input(view.getByRole('slider', { name: 'Tempo' }), { target: { value: '0.75' } })
			await waitFor(() => expect(sent()).toHaveLength(2))
			expect(sent()).toEqual([
				{ type: 'SET_SEMITONES', semitones: -4 },
				{ type: 'SET_TEMPO', tempo: 0.75 },
			])
		})

		it('per-control resets and the tempo stepper', async () => {
			const { view, sent } = await setup()
			await userEvent.click(view.getByRole('button', { name: 'Reset Pitch' }))
			await userEvent.click(view.getByRole('button', { name: 'Reset Tempo' }))
			await userEvent.click(view.getByRole('button', { name: 'Decrease Tempo' }))
			expect(sent()).toEqual([
				{ type: 'SET_SEMITONES', semitones: 0 },
				{ type: 'SET_TEMPO', tempo: 1 },
				{ type: 'NUDGE_TEMPO', delta: -0.05 },
			])
		})

		it('the per-video switch', async () => {
			const { view, sent } = await setup()
			await userEvent.click(view.getByLabelText('Enable for this video'))
			expect(sent()).toEqual([{ type: 'SET_VIDEO_ENABLED', enabled: false }])
		})

		it('the options button', async () => {
			const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined)
			const { view } = await setup()
			await userEvent.click(view.getByRole('button', { name: /options/i }))
			expect(open).toHaveBeenCalledOnce()
		})
	})

	// The tab was reloaded or closed under an open popup.
	it('says contact was lost when the tab stops answering', async () => {
		vi.spyOn(console, 'debug').mockImplementation(() => {})
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockRejectedValue(new Error(NO_RECEIVER))

		await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }))

		expect(await view.findByRole('alert')).toHaveTextContent(/lost contact with this tab/i)
		// Still showing the value the tab last confirmed.
		expect(view.getByRole('slider', { name: 'Pitch' })).toHaveValue('0')
	})

	// A YouTube tab opened before an install or update has no content script. Telling
	// the user to "open a YouTube video" while they watch one is wrong; reload is right.
	it('asks for a reload on a YouTube tab with no content script', async () => {
		mockTabs(null, { url: 'https://www.youtube.com/watch?v=abc' })
		const view = renderApp()
		expect(await view.findByText(/Reload this tab/i)).toBeInTheDocument()
	})

	it('reports a failed state read rather than showing defaults', async () => {
		vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 1 }] as any)
		vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue({
			ok: false,
			error: 'storage',
		} satisfies PopupResponse as never)
		const view = renderApp()
		expect(await view.findByText(/Couldn't read this tab's settings/i)).toBeInTheDocument()
		expect(view.queryByText('Pitch')).not.toBeInTheDocument()
	})

	it('renders the state the content script answers with', async () => {
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockResolvedValue({
			ok: true,
			state: { ...activeState, semitones: 1 },
		} satisfies PopupResponse as never)

		await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }))

		expect(await view.findByText('+1')).toBeInTheDocument()
	})

	// A failed write must not leave the switch in the position the user just clicked.
	it('says so when a change fails, and keeps the control at its real value', async () => {
		const sendMessage = mockTabs(activeState)
		const view = renderApp()
		await view.findByText('Pitch')
		sendMessage.mockResolvedValue({ ok: false, error: 'quota' } satisfies PopupResponse as never)

		await userEvent.click(view.getByLabelText('Master switch'))

		expect(await view.findByRole('alert')).toHaveTextContent(/Couldn't save/i)
		expect(view.getByLabelText('Master switch')).toBeChecked()
	})

	// Popup clicks don't count as activation in the page, so a change made from here
	// on an untouched autoplaying page is silent until the page itself is clicked.
	it('explains that the page needs a click before audio starts', async () => {
		mockTabs({ ...activeState, semitones: 3, audio: 'waiting-for-gesture' })
		const view = renderApp()
		expect(await view.findByRole('status')).toHaveTextContent(/Click anywhere on the YouTube page/i)
	})

	it('explains that an ad plays as is', async () => {
		mockTabs({ ...activeState, semitones: 2, audio: 'ad' })
		const view = renderApp()
		expect(await view.findByText(/an ad is playing/i)).toBeInTheDocument()
	})

	it('surfaces an engine failure', async () => {
		mockTabs({ ...activeState, semitones: 3, audio: 'error' })
		const view = renderApp()
		expect(await view.findByRole('status')).toHaveTextContent(/failed/i)
	})

	describe('live engine status', () => {
		// A change replies before the page has applied it, so the reply carries the
		// old status; the page's answer arrives afterwards and must still show.
		it('shows a status the page reports after the popup opened', async () => {
			mockTabs({ ...activeState, semitones: 3 })
			const view = renderApp()
			await view.findByText('Pitch')
			expect(view.queryByRole('status')).not.toBeInTheDocument()

			await pushStatus('waiting-for-gesture', 1)

			expect(await view.findByRole('status')).toHaveTextContent(/Click anywhere/i)
		})

		it('ignores another tab', async () => {
			mockTabs({ ...activeState, semitones: 3 })
			const view = renderApp()
			await view.findByText('Pitch')

			await pushStatus('error', 1, 2)

			expect(view.queryByRole('status')).not.toBeInTheDocument()
		})

		it('keeps a pushed status over an older one in a later reply', async () => {
			const sendMessage = mockTabs({ ...activeState, semitones: 3 })
			const view = renderApp()
			await view.findByText('Pitch')
			await pushStatus('waiting-for-gesture', 2)
			sendMessage.mockResolvedValue({
				ok: true,
				state: { ...activeState, semitones: 4, audio: 'applied', audioSeq: 1 },
			} satisfies PopupResponse as never)

			await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }))

			expect(await view.findByText('+4')).toBeInTheDocument()
			expect(view.getByRole('status')).toHaveTextContent(/Click anywhere/i)
		})

		it('takes a newer status from a reply', async () => {
			const sendMessage = mockTabs({ ...activeState, semitones: 3 })
			const view = renderApp()
			await view.findByText('Pitch')
			await pushStatus('waiting-for-gesture', 1)
			sendMessage.mockResolvedValue({
				ok: true,
				state: { ...activeState, semitones: 4, audio: 'applied', audioSeq: 2 },
			} satisfies PopupResponse as never)

			await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }))

			await waitFor(() => expect(view.queryByRole('status')).not.toBeInTheDocument())
		})
	})
})
