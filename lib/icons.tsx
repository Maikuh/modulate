type IconProps = { className?: string }

const base = {
	viewBox: '0 0 24 24',
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 2,
	strokeLinecap: 'round' as const,
	strokeLinejoin: 'round' as const,
}

/** Equalizer mark — the Modulate logo. */
export function Logo({ className }: IconProps) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
		>
			<line x1="6" y1="3" x2="6" y2="21" />
			<line x1="12" y1="3" x2="12" y2="21" />
			<line x1="18" y1="3" x2="18" y2="21" />
			<circle cx="6" cy="8.5" r="2.6" fill="currentColor" stroke="none" />
			<circle cx="12" cy="15" r="2.6" fill="currentColor" stroke="none" />
			<circle cx="18" cy="6.5" r="2.6" fill="currentColor" stroke="none" />
		</svg>
	)
}

/** Musical note — pitch. */
export function PitchIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<path d="M9 18V5l12-2v13" />
			<circle cx="6" cy="18" r="3" />
			<circle cx="18" cy="16" r="3" />
		</svg>
	)
}

/** Gauge — tempo. */
export function TempoIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<path d="M3.5 19a9 9 0 1 1 17 0" />
			<path d="M12 12.5 16 9" />
			<circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none" />
		</svg>
	)
}

/** Circular arrow — reset. */
export function ResetIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.5 2.8L3 8" />
			<path d="M3 4v4h4" />
		</svg>
	)
}

/** Gear — options/settings. */
export function GearIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	)
}

/** Power — master switch / general. */
export function PowerIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
			<line x1="12" y1="2" x2="12" y2="12" />
		</svg>
	)
}

/** Sliders — audio quality. */
export function SlidersIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<line x1="4" y1="21" x2="4" y2="14" />
			<line x1="4" y1="10" x2="4" y2="3" />
			<line x1="12" y1="21" x2="12" y2="12" />
			<line x1="12" y1="8" x2="12" y2="3" />
			<line x1="20" y1="21" x2="20" y2="16" />
			<line x1="20" y1="12" x2="20" y2="3" />
			<line x1="1" y1="14" x2="7" y2="14" />
			<line x1="9" y1="8" x2="15" y2="8" />
			<line x1="17" y1="16" x2="23" y2="16" />
		</svg>
	)
}

/** Film — saved videos. */
export function FilmIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<rect x="2" y="3" width="20" height="18" rx="2.5" />
			<line x1="7" y1="3" x2="7" y2="21" />
			<line x1="17" y1="3" x2="17" y2="21" />
			<line x1="2" y1="9" x2="7" y2="9" />
			<line x1="2" y1="15" x2="7" y2="15" />
			<line x1="17" y1="9" x2="22" y2="9" />
			<line x1="17" y1="15" x2="22" y2="15" />
		</svg>
	)
}

/** Trash — remove. */
export function TrashIcon({ className }: IconProps) {
	return (
		<svg className={className} {...base}>
			<path d="M3 6h18" />
			<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
			<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
		</svg>
	)
}
