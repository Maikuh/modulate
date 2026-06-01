import { render, within } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'

import { Toggle } from './Toggle'

// Scope queries to this render's container — WxtVitest runs without DOM isolation.
function setup(props: Parameters<typeof Toggle>[0]) {
	return within(render(<Toggle {...props} />).container as HTMLElement)
}

describe('Toggle', () => {
	it('reflects the checked prop', () => {
		const view = setup({ checked: true, onChange: () => {}, 'aria-label': 't' })
		expect(view.getByRole('checkbox')).toBeChecked()
	})

	it('fires onChange with the toggled value', async () => {
		const onChange = vi.fn()
		const view = setup({ checked: false, onChange, 'aria-label': 't' })
		await userEvent.click(view.getByRole('checkbox'))
		expect(onChange).toHaveBeenCalledWith(true)
	})

	it('does not fire when disabled', async () => {
		const onChange = vi.fn()
		const view = setup({ checked: false, onChange, disabled: true, 'aria-label': 't' })
		await userEvent.click(view.getByRole('checkbox'))
		expect(onChange).not.toHaveBeenCalled()
	})
})
