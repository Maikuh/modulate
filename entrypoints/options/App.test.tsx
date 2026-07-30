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

// Scope queries to this render's container. Both toggles carry an `aria-label`,
// so address them by name rather than by position — an index would silently
// retarget to the wrong control the moment a checkbox is added above them.
function renderApp() {
	const view = within(render(<App />).container as HTMLElement)
	return {
		view,
		globalSwitch: () => view.getByLabelText('Enable Modulate'),
		quickSeekSwitch: () => view.getByLabelText('Quick seek'),
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
		await userEvent.click(view.getByLabelText('Remove vid1'))
		await waitFor(() => expect(view.queryByText('vid1')).not.toBeInTheDocument())
		expect(await listVideoSettings()).toEqual({})
	})

	// Each row's delete button names its row, so a screen reader on a long list
	// doesn't announce N identical "Remove" buttons.
	it('gives each remove button a distinct accessible name', async () => {
		// Needs a real setting on each: a title alone is a no-op entry, which
		// setVideoSetting prunes rather than stores.
		await setVideoSetting('vid1', { semitones: 2, title: 'First Song' })
		await setVideoSetting('vid2', { tempo: 1.25, title: 'Second Song' })
		const { view } = renderApp()
		expect(await view.findByLabelText('Remove First Song')).toBeInTheDocument()
		expect(view.getByLabelText('Remove Second Song')).toBeInTheDocument()
	})

	// The popup writes the same storage, so an open options page must not keep
	// showing a master switch position that another surface has since changed.
	it('reflects a global switch change made elsewhere', async () => {
		const { globalSwitch } = renderApp()
		await waitFor(() => expect(globalSwitch()).toBeChecked())
		await globalEnabled.setValue(false)
		await waitFor(() => expect(globalSwitch()).not.toBeChecked())
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
