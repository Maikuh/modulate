interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onSet: (value: number) => void;
  disabled?: boolean;
}

export function Slider({ value, min, max, step, onSet, disabled }: SliderProps) {
  return (
    <input
      type="range"
      className="slider"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onSet(Number(e.target.value))}
    />
  );
}
