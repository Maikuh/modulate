import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'

import { ResetIcon } from '@/lib/icons'

import { Slider } from './Slider'

interface ControlRowProps {
	label: string
	icon: ComponentChildren
	value: number
	min: number
	max: number
	step: number
	/** Value the control returns to; the reset affordance shows only when away from it. */
	resetValue: number
	displayValue: (v: number) => ComponentChildren
	onStep: (delta: number) => void
	/** Set an absolute value. Settles once the change is saved (or failed). */
	onSet: (value: number) => void | Promise<unknown>
	onReset: () => void
	disabled?: boolean
}

export function ControlRow({
	label,
	icon,
	value,
	min,
	max,
	step,
	resetValue,
	displayValue,
	onStep,
	onSet,
	onReset,
	disabled,
}: ControlRowProps) {
	// The value under the slider thumb while it moves. Each step it passes is sent
	// at once, but the replies trail the thumb — rendering `value` from them mid-drag
	// would snap the thumb back to a step it already left. So the row shows the
	// draft until the thumb is released and the last send has settled.
	const draft = useSignal<number | null>(null)
	const lastSet = useRef<Promise<unknown>>(Promise.resolve())
	const shown = draft.value ?? value

	function onSlide(next: number) {
		draft.value = next
		// Tracked only to know when it settles; reporting a failure is the caller's.
		lastSet.current = Promise.resolve(onSet(next)).then(
			() => {},
			() => {},
		)
	}

	function onRelease(next: number) {
		// `input` has already sent this value; `change` only ends the drag.
		if (draft.value !== next) onSlide(next)
		const settled = lastSet.current
		void settled.finally(() => {
			// A newer drag started meanwhile and owns the draft now.
			if (lastSet.current === settled) draft.value = null
		})
	}

	return (
		<div className={`ctrl${disabled ? ' ctrl--disabled' : ''}`}>
			<div className="ctrl__top">
				<span className="ctrl__label">
					{icon}
					{label}
				</span>
				<span className="ctrl__readout">
					{shown !== resetValue && (
						<button
							className="ctrl__reset"
							onClick={onReset}
							// The row's dimming stops pointer clicks only; this stops the keyboard.
							disabled={disabled}
							aria-label={`Reset ${label}`}
						>
							<ResetIcon />
						</button>
					)}
					<span className="ctrl__value">{displayValue(shown)}</span>
				</span>
			</div>
			<div className="ctrl__track">
				<button
					className="step"
					onClick={() => onStep(-step)}
					disabled={disabled || shown <= min}
					aria-label={`Decrease ${label}`}
				>
					−
				</button>
				<Slider
					label={label}
					value={shown}
					min={min}
					max={max}
					step={step}
					onInput={onSlide}
					onCommit={onRelease}
					disabled={disabled}
				/>
				<button
					className="step"
					onClick={() => onStep(step)}
					disabled={disabled || shown >= max}
					aria-label={`Increase ${label}`}
				>
					+
				</button>
			</div>
		</div>
	)
}
