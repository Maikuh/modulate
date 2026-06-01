import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { Logo, PitchIcon, TempoIcon, ResetIcon, GearIcon } from '@/lib/icons'
import type { PlayerState, PopupMessage } from '@/lib/messaging'
import { MIN_SEMITONES, MAX_SEMITONES, MIN_TEMPO, MAX_TEMPO, TEMPO_STEP } from '@/lib/storage'

import { ControlRow } from './components/ControlRow'
import { Toggle } from './components/Toggle'

/** Send a message to the content script in the active tab; null if none responds. */
async function send(msg: PopupMessage): Promise<PlayerState | null> {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
	if (tab?.id == null) return null
	try {
		return (await browser.tabs.sendMessage(tab.id, msg)) as PlayerState
	} catch {
		// No content script in this tab (not a YouTube page).
		return null
	}
}

function App() {
	const state = useSignal<PlayerState | null>(null)
	const loading = useSignal(true)

	// Mount-once load; signals are stable refs, so no deps.
	useEffect(() => {
		send({ type: 'GET_STATE' })
			.then((s) => (state.value = s))
			.finally(() => (loading.value = false))
	}, [])

	async function dispatch(msg: PopupMessage) {
		const s = await send(msg)
		if (s) state.value = s
	}

	if (loading.value) {
		return (
			<div className="popup">
				<div className="state">
					<span className="state__mark">
						<Logo />
					</span>
					<span className="dots">
						<span />
						<span />
						<span />
					</span>
				</div>
			</div>
		)
	}

	const s = state.value
	const onYouTube = s?.videoId != null

	if (!s || !onYouTube) {
		return (
			<div className="popup">
				<div className="state">
					<span className="state__mark">
						<Logo />
					</span>
					<h1 className="state__title">Modulate</h1>
					<p className="state__msg">Open a YouTube video to shift its pitch and bend its tempo.</p>
				</div>
			</div>
		)
	}

	const controlsDisabled = !s.globalEnabled || !s.enabled

	return (
		<div className="popup">
			<header className="topbar">
				<div className="brand">
					<span className="brand__mark">
						<Logo />
					</span>
					<span className="brand__text">
						<span className="brand__name">Modulate</span>
						<span className="brand__sub">Pitch &amp; tempo</span>
					</span>
				</div>
				<div className="topbar__right">
					<span className={`master-state${s.globalEnabled ? ' master-state--on' : ''}`}>
						{s.globalEnabled ? 'On' : 'Off'}
					</span>
					<Toggle
						checked={s.globalEnabled}
						aria-label="Master switch"
						onChange={(enabled) => dispatch({ type: 'SET_GLOBAL_ENABLED', enabled })}
					/>
				</div>
			</header>

			<main className="body">
				{!s.globalEnabled && (
					<p className="paused">Modulate is off. Flip the switch to start tuning audio.</p>
				)}

				<ControlRow
					label="Pitch"
					icon={<PitchIcon />}
					value={s.semitones}
					min={MIN_SEMITONES}
					max={MAX_SEMITONES}
					step={1}
					resetValue={0}
					displayValue={(v) => (
						<>
							{v > 0 ? `+${v}` : v}
							<small>st</small>
						</>
					)}
					onStep={(delta) => dispatch({ type: 'NUDGE_SEMITONES', delta })}
					onSet={(semitones) => dispatch({ type: 'SET_SEMITONES', semitones })}
					onReset={() => dispatch({ type: 'SET_SEMITONES', semitones: 0 })}
					disabled={controlsDisabled}
				/>

				<div className="divider" />

				<ControlRow
					label="Tempo"
					icon={<TempoIcon />}
					value={s.tempo}
					min={MIN_TEMPO}
					max={MAX_TEMPO}
					step={TEMPO_STEP}
					resetValue={1}
					displayValue={(v) => (
						<>
							{v.toFixed(2)}
							<small>×</small>
						</>
					)}
					onStep={(delta) => dispatch({ type: 'NUDGE_TEMPO', delta })}
					onSet={(tempo) => dispatch({ type: 'SET_TEMPO', tempo })}
					onReset={() => dispatch({ type: 'SET_TEMPO', tempo: 1 })}
					disabled={controlsDisabled}
				/>

				<div className="divider" />

				<div className={`vid${!s.globalEnabled ? ' vid--disabled' : ''}`}>
					<span className="vid__text">
						<span className="vid__label">This video</span>
						<span className="vid__desc">Apply saved pitch &amp; tempo here</span>
					</span>
					<Toggle
						checked={s.enabled}
						disabled={!s.globalEnabled}
						aria-label="Enable for this video"
						onChange={(enabled) => dispatch({ type: 'SET_VIDEO_ENABLED', enabled })}
					/>
				</div>
			</main>

			<footer className="actions">
				<button className="action" onClick={() => dispatch({ type: 'RESET' })}>
					<ResetIcon />
					Reset
				</button>
				<button className="action" onClick={() => browser.runtime.openOptionsPage()}>
					<GearIcon />
					Options
				</button>
			</footer>
		</div>
	)
}

export default App
