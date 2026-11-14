import { render, fireEvent, waitFor, within } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'

import { ControlRow } from './ControlRow'

// Scope queries to this render's container: `render` appends to document.body
// and sibling cases in the same file share it.
function setup(overrides: Partial<Parameters<typeof ControlRow>[0]> = {}) {
	const props = {
		label: 'Pitch',
		icon: null,
		value: 0,
		min: -12,
		max: 12,
		step: 1,
		resetValue: 0,
		displayValue: (v: number) => <>{v}</>,
		onStep: vi.fn(),
		onSet: vi.fn(),
		onReset: vi.fn(),
		...overrides,
	}
	const view = within(render(<ControlRow {...props} />).container as HTMLElement)
	return {
		props,
		view,
		decrease: () => view.getByRole('button', { name: 'Decrease Pitch' }),
		increase: () => view.getByRole('button', { name: 'Increase Pitch' }),
	}
}

describe('ControlRow', () => {
	it('renders the formatted readout', () => {
		const { view } = setup({ value: 5, displayValue: (v) => <>{v} st</> })
		expect(view.getByText('5 st')).toBeInTheDocument()
	})

	it('steps down by -step on the decrease button', async () => {
		const { props, decrease } = setup({ value: 0, step: 1 })
		await userEvent.click(decrease())
		expect(props.onStep).toHaveBeenCalledWith(-1)
	})

	it('steps up by +step on the increase button', async () => {
		const { props, increase } = setup({ value: 0, step: 1 })
		await userEvent.click(increase())
		expect(props.onStep).toHaveBeenCalledWith(1)
	})

	it('disables the decrease button at min', () => {
		const { decrease } = setup({ value: -12, min: -12 })
		expect(decrease()).toBeDisabled()
	})

	it('disables the increase button at max', () => {
		const { increase } = setup({ value: 12, max: 12 })
		expect(increase()).toBeDisabled()
	})

	it('disables all controls when disabled', () => {
		const { view, decrease, increase } = setup({ value: 0, disabled: true })
		expect(decrease()).toBeDisabled()
		expect(increase()).toBeDisabled()
		expect(view.getByRole('slider')).toBeDisabled()
	})

	it('sets each value the slider passes while it is dragged', () => {
		const { props, view } = setup({ value: 0, min: -12, max: 12, step: 1 })
		const slider = view.getByRole('slider')
		fireEvent.input(slider, { target: { value: '3' } })
		fireEvent.input(slider, { target: { value: '4' } })
		expect(vi.mocked(props.onSet).mock.calls).toEqual([[3], [4]])
	})

	it('moves the readout with the thumb, before any reply', () => {
		const { view } = setup({ value: 0, onSet: () => new Promise(() => {}) })
		fireEvent.input(view.getByRole('slider'), { target: { value: '4' } })
		expect(view.getByText('4')).toBeInTheDocument()
		expect(view.getByRole('slider')).toHaveValue('4')
	})

	it('does not send the released value a second time', () => {
		const { props, view } = setup({ value: 0 })
		const slider = view.getByRole('slider')
		fireEvent.input(slider, { target: { value: '4' } })
		fireEvent.change(slider)
		expect(props.onSet).toHaveBeenCalledTimes(1)
	})

	it('sends a value that only arrives on release', () => {
		const { props, view } = setup({ value: 0 })
		fireEvent.change(view.getByRole('slider'), { target: { value: '4' } })
		expect(props.onSet).toHaveBeenCalledWith(4)
	})

	// Replies trail the thumb: a reply for a step already left must not snap it back.
	it('holds the dragged value over a lagging reply, then follows the value again', async () => {
		let settle: () => void = () => {}
		const onSet = vi.fn(() => new Promise<void>((r) => (settle = r)))
		const props = {
			label: 'Pitch',
			icon: null,
			min: -12,
			max: 12,
			step: 1,
			resetValue: 0,
			displayValue: (v: number) => <>{v}</>,
			onStep: vi.fn(),
			onSet,
			onReset: vi.fn(),
		}
		const { container, rerender } = render(<ControlRow {...props} value={0} />)
		const view = within(container as HTMLElement)
		const slider = view.getByRole('slider')

		fireEvent.input(slider, { target: { value: '5' } })
		rerender(<ControlRow {...props} value={2} />) // a reply for an earlier step
		expect(slider).toHaveValue('5')

		fireEvent.change(slider)
		expect(slider).toHaveValue('5') // released, last send still in flight
		rerender(<ControlRow {...props} value={5} />)
		settle()
		await waitFor(() => expect(slider).toHaveValue('5'))

		// The draft is gone: the row shows what it is given from here on.
		rerender(<ControlRow {...props} value={-3} />)
		await waitFor(() => expect(slider).toHaveValue('-3'))
		expect(view.getByText('-3')).toBeInTheDocument()
	})

	it('drops the draft after a failed send too', async () => {
		const props = {
			label: 'Pitch',
			icon: null,
			min: -12,
			max: 12,
			step: 1,
			resetValue: 0,
			displayValue: (v: number) => <>{v}</>,
			onStep: vi.fn(),
			onSet: vi.fn(async () => {
				throw new Error('nope')
			}),
			onReset: vi.fn(),
		}
		const { container } = render(<ControlRow {...props} value={0} />)
		const slider = within(container as HTMLElement).getByRole('slider')
		fireEvent.input(slider, { target: { value: '5' } })
		fireEvent.change(slider)
		await waitFor(() => expect(slider).toHaveValue('0'))
	})
})
