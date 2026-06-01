import type { ComponentChildren } from 'preact'

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
	onSet: (value: number) => void
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
	return (
		<div className={`ctrl${disabled ? ' ctrl--disabled' : ''}`}>
			<div className="ctrl__top">
				<span className="ctrl__label">
					{icon}
					{label}
				</span>
				<span className="ctrl__readout">
					{value !== resetValue && (
						<button className="ctrl__reset" onClick={onReset} aria-label={`Reset ${label}`}>
							<ResetIcon />
						</button>
					)}
					<span className="ctrl__value">{displayValue(value)}</span>
				</span>
			</div>
			<div className="ctrl__track">
				<button
					className="step"
					onClick={() => onStep(-step)}
					disabled={disabled || value <= min}
					aria-label={`Decrease ${label}`}
				>
					−
				</button>
				<Slider
					label={label}
					value={value}
					min={min}
					max={max}
					step={step}
					onSet={onSet}
					disabled={disabled}
				/>
				<button
					className="step"
					onClick={() => onStep(step)}
					disabled={disabled || value >= max}
					aria-label={`Increase ${label}`}
				>
					+
				</button>
			</div>
		</div>
	)
}
