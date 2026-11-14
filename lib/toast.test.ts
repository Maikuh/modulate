import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOAST_MS, removeToast, showToast } from '@/lib/toast'

const host = () => document.querySelector('modulate-toast')
const box = () => host()?.shadowRoot?.querySelector<HTMLElement>('[role="status"]')

afterEach(() => {
	removeToast()
	vi.useRealTimers()
	Reflect.deleteProperty(document, 'fullscreenElement')
})

describe('showToast', () => {
	it('shows the text in an isolated, announced notice', () => {
		showToast('Pitch +1 st')
		expect(box()?.textContent).toBe('Pitch +1 st')
		expect(box()?.classList.contains('shown')).toBe(true)
		expect(host()?.parentNode).toBe(document.documentElement)
	})

	it('replaces the text and restarts the timer rather than stacking notices', () => {
		vi.useFakeTimers()
		showToast('Pitch +1 st')
		vi.advanceTimersByTime(TOAST_MS - 100)
		showToast('Pitch +2 st')
		vi.advanceTimersByTime(TOAST_MS - 100)

		expect(document.querySelectorAll('modulate-toast')).toHaveLength(1)
		expect(box()?.textContent).toBe('Pitch +2 st')
		expect(box()?.classList.contains('shown')).toBe(true)

		vi.advanceTimersByTime(100)
		expect(box()?.classList.contains('shown')).toBe(false)
	})

	// In fullscreen only the fullscreen element's subtree renders.
	it('moves into the fullscreen element', () => {
		const player = document.createElement('div')
		document.body.append(player)
		Object.defineProperty(document, 'fullscreenElement', { value: player, configurable: true })

		showToast('Tempo 1.25×')

		expect(host()?.parentNode).toBe(player)
		player.remove()
	})

	it('leaves nothing behind once removed', () => {
		showToast('Pitch +1 st')
		removeToast()
		expect(host()).toBeNull()
	})
})
