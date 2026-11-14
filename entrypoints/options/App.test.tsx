import { render, within, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

import { globalEnabled, setVideoSetting, listVideoSettings } from '@/lib/storage'

import App from './App'

beforeEach(() => {
	fakeBrowser.reset()
	// fakeBrowser has no getManifest; the header reads .version off it.
	vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({ version: '0.0.0' } as any)
})

// Scope queries to this render's container. Address the switch by name rather
// than by position — an index would silently retarget to the wrong control the
// moment a checkbox is added above it.
/** Write entries as an older version did: straight to storage, no `updatedAt`. */
async function seedRaw(entries: Record<string, object>) {
	await fakeBrowser.storage.local.set(
		Object.fromEntries(Object.entries(entries).map(([id, v]) => [`video:${id}`, v])),
	)
}

function renderApp() {
	const view = within(render(<App />).container as HTMLElement)
	return {
		view,
		globalSwitch: () => view.getByLabelText('Enable Modulate'),
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

	it('rolls a failed write back to the stored value and says so', async () => {
		const { view, globalSwitch } = renderApp()
		await waitFor(() => expect(globalSwitch()).toBeChecked())
		vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota'))
		vi.spyOn(console, 'error').mockImplementation(() => {})

		await userEvent.click(globalSwitch())

		expect(await view.findByRole('alert')).toHaveTextContent(/could not save/i)
		await waitFor(() => expect(globalSwitch()).toBeChecked())
		expect(await globalEnabled.getValue()).toBe(true)
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

	it('clears all saved videos once confirmed', async () => {
		await setVideoSetting('a', { semitones: 1 })
		await setVideoSetting('b', { semitones: 2 })
		const { view } = renderApp()
		await view.findByText('a')

		await userEvent.click(view.getByRole('button', { name: /clear all/i }))
		expect(view.getByText(/remove all 2 saved videos\?/i)).toBeInTheDocument()
		expect(await listVideoSettings()).toHaveProperty('a') // nothing yet

		await userEvent.click(view.getByRole('button', { name: /remove all/i }))
		await waitFor(() => expect(view.queryByText('a')).not.toBeInTheDocument())
		expect(await listVideoSettings()).toEqual({})
	})

	it('keeps everything when the clear is cancelled', async () => {
		await setVideoSetting('a', { semitones: 1 })
		const { view } = renderApp()
		await view.findByText('a')

		await userEvent.click(view.getByRole('button', { name: /clear all/i }))
		const cancel = view.getByRole('button', { name: 'Cancel' })
		expect(cancel).toHaveFocus() // the safe answer, so Enter can't wipe the list
		await userEvent.click(cancel)

		expect(view.getByRole('button', { name: /clear all/i })).toHaveFocus()
		expect(await listVideoSettings()).toHaveProperty('a')
	})

	it('dismisses the question with Escape', async () => {
		await setVideoSetting('a', { semitones: 1 })
		const { view } = renderApp()
		await view.findByText('a')

		await userEvent.click(view.getByRole('button', { name: /clear all/i }))
		await userEvent.keyboard('{Escape}')

		expect(view.queryByRole('button', { name: /remove all/i })).not.toBeInTheDocument()
		expect(await listVideoSettings()).toHaveProperty('a')
	})

	it('lists recently tuned videos first, then older entries by name', async () => {
		const now = vi.spyOn(Date, 'now')
		await seedRaw({ zz: { semitones: 1, title: 'Zebra' }, aa: { semitones: 1, title: 'Aardvark' } })
		now.mockReturnValue(1000)
		await setVideoSetting('old', { semitones: 1, title: 'Older' })
		now.mockReturnValue(2000)
		await setVideoSetting('new', { semitones: 1, title: 'Newer' })
		now.mockRestore()

		const { view } = renderApp()
		await view.findByText('Newer')
		const names = view.getAllByRole('link').map((a) => a.getAttribute('title'))
		expect(names).toEqual(['Newer', 'Older', 'Aardvark', 'Zebra'])
	})

	it('switches one video off and on from its row', async () => {
		await setVideoSetting('a', { semitones: 3, title: 'Song' })
		const { view } = renderApp()
		const toggle = await view.findByRole('checkbox', { name: 'Apply settings to Song' })
		expect(toggle).toBeChecked()

		await userEvent.click(toggle)
		await waitFor(async () =>
			expect(await listVideoSettings()).toMatchObject({ a: { enabled: false, semitones: 3 } }),
		)
		await waitFor(() => expect(toggle).not.toBeChecked())
	})

	it('offers a search once the list is long, and filters by title or id', async () => {
		for (let i = 0; i < 7; i++)
			await setVideoSetting(`id${i}`, { semitones: 1, title: `Song ${i}` })
		await setVideoSetting('needle', { semitones: 2, title: 'Haystack' })
		const { view } = renderApp()
		const search = await view.findByRole('searchbox', { name: 'Search saved videos' })

		await userEvent.type(search, 'hay')
		expect(view.getAllByRole('link').map((a) => a.getAttribute('title'))).toEqual(['Haystack'])

		await userEvent.clear(search)
		await userEvent.type(search, 'id3')
		expect(view.getAllByRole('link').map((a) => a.getAttribute('title'))).toEqual(['Song 3'])

		await userEvent.type(search, 'x')
		expect(view.getByText(/no saved video matches/i)).toBeInTheDocument()
	})

	it('keeps a short list without a search box', async () => {
		await setVideoSetting('a', { semitones: 1 })
		const { view } = renderApp()
		await view.findByText('a')
		expect(view.queryByRole('searchbox')).not.toBeInTheDocument()
	})

	it('asks about one video in the singular', async () => {
		await setVideoSetting('a', { semitones: 1 })
		const { view } = renderApp()
		await view.findByText('a')
		await userEvent.click(view.getByRole('button', { name: /clear all/i }))
		expect(view.getByText(/remove the saved video\?/i)).toBeInTheDocument()
	})
})
