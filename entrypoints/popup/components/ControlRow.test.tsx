import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlRow } from './ControlRow';

// WxtVitest runs test files without DOM isolation, so leftover trees can linger
// in document.body. Scope every query to this render's own container.
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
  };
  const view = within(render(<ControlRow {...props} />).container);
  return {
    props,
    view,
    decrease: () => view.getByRole('button', { name: 'Decrease Pitch' }),
    increase: () => view.getByRole('button', { name: 'Increase Pitch' }),
  };
}

describe('ControlRow', () => {
  it('renders the formatted readout', () => {
    const { view } = setup({ value: 5, displayValue: (v) => <>{v} st</> });
    expect(view.getByText('5 st')).toBeInTheDocument();
  });

  it('steps down by -step on the decrease button', async () => {
    const { props, decrease } = setup({ value: 0, step: 1 });
    await userEvent.click(decrease());
    expect(props.onStep).toHaveBeenCalledWith(-1);
  });

  it('steps up by +step on the increase button', async () => {
    const { props, increase } = setup({ value: 0, step: 1 });
    await userEvent.click(increase());
    expect(props.onStep).toHaveBeenCalledWith(1);
  });

  it('disables the decrease button at min', () => {
    const { decrease } = setup({ value: -12, min: -12 });
    expect(decrease()).toBeDisabled();
  });

  it('disables the increase button at max', () => {
    const { increase } = setup({ value: 12, max: 12 });
    expect(increase()).toBeDisabled();
  });

  it('disables all controls when disabled', () => {
    const { view, decrease, increase } = setup({ value: 0, disabled: true });
    expect(decrease()).toBeDisabled();
    expect(increase()).toBeDisabled();
    expect(view.getByRole('slider')).toBeDisabled();
  });

  it('fires onSet from the slider', () => {
    const { props, view } = setup({ value: 0, min: -12, max: 12, step: 1 });
    fireEvent.change(view.getByRole('slider'), { target: { value: '4' } });
    expect(props.onSet).toHaveBeenCalledWith(4);
  });
});
