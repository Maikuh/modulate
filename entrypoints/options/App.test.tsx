import { render, within, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import {
	globalEnabled,
	audioQuality,
	setVideoSetting,
	listVideoSettings,
	DEFAULT_AUDIO_QUALITY,
} from '@/lib/storage'

import App from './App'

beforeEach(() => {
	fakeBrowser.reset()
	// fakeBrowser has no getManifest; the header reads .version off it.
	vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({ version: '0.0.0' } as any)
})

// WxtVitest runs without DOM isolation; scope queries to this render's container.
// The styled toggles render bare checkboxes with no accessible name; within a
// single App the only two are, in order, the global "Enable Modulate" switch and
// the "Quick seek" quality toggle.
function renderApp() {
	const view = within(render(<App />).container as HTMLElement)
	return {
		view,
		globalSwitch: () => view.getAllByRole('checkbox')[0],
		quickSeekSwitch: () => view.getAllByRole('checkbox')[1],
	}
}

describe('options App', () => {
	it('loads the global switch from storage on mount', async () => {
		await globalEnabled.setValue(false)
		const { globalSwitch } = renderApp()
		await waitFor(() => expect(globalSwitch()).not.toBeChecked())
	})

	it('writes the global switch back to storage on toggle', async () => {
		const { globalSwitch } = renderApp()
		await waitFor(() => expect(globalSwitch()).toBeChecked())
		await userEvent.click(globalSwitch())
		await waitFor(async () => expect(await globalEnabled.getValue()).toBe(false))
	})

	it('persists a quality knob edit', async () => {
		const { quickSeekSwitch } = renderApp()
		await waitFor(() => expect(quickSeekSwitch()).toBeChecked())
		await userEvent.click(quickSeekSwitch())
		await waitFor(async () => expect((await audioQuality.getValue()).quickSeek).toBe(false))
	})

	it('shows the empty state when no videos are saved', async () => {
		const { view } = renderApp()
		expect(await view.findByText(/No saved videos yet/i)).toBeInTheDocument()
	})

	it('lists saved videos and removes one', async () => {
		await setVideoSetting('vid1', { semitones: 3, tempo: 1.5 })
		const { view } = renderApp()
		expect(await view.findByText('vid1')).toBeInTheDocument()
		await userEvent.click(view.getByLabelText('Remove'))
		await waitFor(() => expect(view.queryByText('vid1')).not.toBeInTheDocument())
		expect(await listVideoSettings()).toEqual({})
	})

	it('clears all saved videos', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await setVideoSetting('b', { semitones: 2 })
		const { view } = renderApp()
		await view.findByText('a')
		await userEvent.click(view.getByRole('button', { name: /clear all/i }))
		await waitFor(() => expect(view.queryByText('a')).not.toBeInTheDocument())
		expect(await listVideoSettings()).toEqual({})
	})

	it('restores quality defaults', async () => {
		await audioQuality.setValue({ ...DEFAULT_AUDIO_QUALITY, quickSeek: false })
		const { view, quickSeekSwitch } = renderApp()
		await waitFor(() => expect(quickSeekSwitch()).not.toBeChecked())
		await userEvent.click(view.getByRole('button', { name: /restore/i }))
		await waitFor(async () => expect(await audioQuality.getValue()).toEqual(DEFAULT_AUDIO_QUALITY))
	})
})
