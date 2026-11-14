interface SliderProps {
	label: string
	value: number
	min: number
	max: number
	step: number
	/** Every value the thumb passes through (drag, arrow keys). */
	onInput: (value: number) => void
	/** The value the thumb was released on (or each arrow-key press). */
	onCommit: (value: number) => void
	disabled?: boolean
}

export function Slider({ label, value, min, max, step, onInput, onCommit, disabled }: SliderProps) {
	return (
		<input
			type="range"
			className="slider"
			aria-label={label}
			value={value}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			// Preact's `onChange` is the native `change`, which fires only on release:
			// listen to `input` too, so the readout and the audio follow the drag.
			onInput={(e) => onInput(Number(e.currentTarget.value))}
			onChange={(e) => onCommit(Number(e.currentTarget.value))}
		/>
	)
}
