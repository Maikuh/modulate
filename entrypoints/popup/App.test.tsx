import { render, within, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import type { PlayerState, PopupMessage, PopupResponse } from '@/lib/messaging'

import App from './App'

const activeState: PlayerState = {
	videoId: 'abc',
	globalEnabled: true,
	enabled: true,
	semitones: 0,
	tempo: 1,
	audio: 'applied',
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
		expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({
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
		expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({
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
		expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({ type: 'RESET' })
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

	it('surfaces an engine failure', async () => {
		mockTabs({ ...activeState, semitones: 3, audio: 'error' })
		const view = renderApp()
		expect(await view.findByRole('status')).toHaveTextContent(/failed/i)
	})
})
