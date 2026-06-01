interface SliderProps {
	label: string
	value: number
	min: number
	max: number
	step: number
	onSet: (value: number) => void
	disabled?: boolean
}

export function Slider({ label, value, min, max, step, onSet, disabled }: SliderProps) {
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
			onChange={(e) => onSet(Number(e.currentTarget.value))}
		/>
	)
}
