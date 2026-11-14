/**
 * A brief on-page notice for changes made with a keyboard shortcut, which
 * otherwise only show in a 16-pixel toolbar badge. Content-script only.
 *
 * Isolated in a shadow root so YouTube's styles can't reach it (nor its ours),
 * and re-parented on every show into the fullscreen element when there is one:
 * in fullscreen only that element's subtree renders, fixed-position or not.
 */

const HOST_TAG = 'modulate-toast'
/** How long a notice stays up after the last change. */
export const TOAST_MS = 1400

const STYLE = `
:host { all: initial; }
.toast {
	position: fixed;
	top: 72px;
	left: 50%;
	z-index: 2147483647;
	transform: translateX(-50%);
	padding: 8px 14px;
	border-radius: 999px;
	background: rgba(15, 15, 18, 0.88);
	color: #f4f4f6;
	font: 600 14px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
	letter-spacing: 0.01em;
	white-space: nowrap;
	pointer-events: none;
	opacity: 0;
	transition: opacity 0.15s ease;
}
.toast.shown { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
	.toast { transition: none; }
}
`

let host: HTMLElement | null = null
let box: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function mount(): HTMLElement {
	if (!host || !box) {
		host = document.createElement(HOST_TAG)
		const root = host.attachShadow({ mode: 'open' })
		const style = document.createElement('style')
		style.textContent = STYLE
		box = document.createElement('div')
		box.className = 'toast'
		// Announced to screen readers without moving focus.
		box.setAttribute('role', 'status')
		root.append(style, box)
	}
	const parent = document.fullscreenElement ?? document.documentElement
	if (host.parentNode !== parent) parent.append(host)
	return box
}

/** Show `text`, replacing any notice still up; it fades after `TOAST_MS`. */
export function showToast(text: string): void {
	const el = mount()
	el.textContent = text
	el.classList.add('shown')
	clearTimeout(timer)
	timer = setTimeout(() => el.classList.remove('shown'), TOAST_MS)
}

/** Remove the notice from the page (the content script is going away). */
export function removeToast(): void {
	clearTimeout(timer)
	host?.remove()
	host = null
	box = null
}
