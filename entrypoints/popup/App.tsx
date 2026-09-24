import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { Logo, PitchIcon, TempoIcon, ResetIcon, GearIcon } from '@/lib/icons'
import {
	logSendFailure,
	type AudioStatus,
	type PlayerState,
	type PopupMessage,
	type PopupResponse,
} from '@/lib/messaging'
import { MIN_SEMITONES, MAX_SEMITONES, MIN_TEMPO, MAX_TEMPO, TEMPO_STEP } from '@/lib/settings'

import { ControlRow } from './components/ControlRow'
import { Toggle } from './components/Toggle'

type SendResult =
	/** The content script answered with the tab's state. */
	| { kind: 'state'; state: PlayerState }
	/** The content script answered, but handling the message failed. */
	| { kind: 'failed' }
	/** No content script answered. `url` only when the browser lets us read it. */
	| { kind: 'unreachable'; url?: string }

const YOUTUBE_URL = /^https?:\/\/([^/]+\.)?youtube\.com\//

/** Send a message to the content script in the active tab. */
async function send(msg: PopupMessage): Promise<SendResult> {
	let tab
	try {
		;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
	} catch (err) {
		console.error('[modulate] could not read the active tab', err)
		return { kind: 'failed' }
	}
	if (tab?.id == null) return { kind: 'unreachable' }
	let res: PopupResponse | undefined
	try {
		res = (await browser.tabs.sendMessage(tab.id, msg)) as PopupResponse | undefined
	} catch (err) {
		// Usually "not a YouTube page". But the same rejection covers a YouTube tab
		// that predates an extension install or update and so has no content script
		// yet — the empty state tells those apart when the tab URL is readable.
		logSendFailure('no content script in the active tab', err)
		return { kind: 'unreachable', url: tab.url }
	}
	if (!res) return { kind: 'unreachable', url: tab.url }
	return res.ok ? { kind: 'state', state: res.state } : { kind: 'failed' }
}

/** Why the controls can't be shown, as the message to show instead. */
function emptyMessage(result: SendResult | null): string {
	if (result?.kind === 'failed')
		return "Couldn't read this tab's settings. Reload the tab to try again."
	if (result?.kind === 'unreachable') {
		// A YouTube tab with no content script predates an install or update.
		if (result.url && YOUTUBE_URL.test(result.url))
			return 'Reload this tab to start using Modulate on it.'
		if (!result.url) {
			return 'Open a YouTube video to shift its pitch and bend its tempo. Already on one? Reload the tab.'
		}
	}
	return 'Open a YouTube video to shift its pitch and bend its tempo.'
}

/** What the page engine is doing, when that is not simply "playing it". */
const AUDIO_NOTICE: Partial<Record<AudioStatus, { text: string; error?: boolean }>> = {
	'waiting-for-gesture': {
		text: 'Click anywhere on the YouTube page to start. Browsers hold processed audio until the page itself is clicked.',
	},
	'no-video': { text: 'No video player found on this page yet.' },
	error: { text: 'Audio processing failed on this page. Reload the tab to retry.', error: true },
}

function App() {
	const state = useSignal<PlayerState | null>(null)
	const initial = useSignal<SendResult | null>(null)
	const error = useSignal<string | null>(null)
	const loading = useSignal(true)

	// Mount-once load; signals are stable refs, so no deps.
	useEffect(() => {
		send({ type: 'GET_STATE' })
			.then((r) => {
				initial.value = r
				if (r.kind === 'state') state.value = r.state
			})
			// `send` already handles its own failures, but a throw here would leave the
			// popup stuck on the loading dots forever with nothing logged.
			.catch((err) => console.error('[modulate] popup state load failed', err))
			.finally(() => (loading.value = false))
	}, [])

	async function dispatch(msg: PopupMessage) {
		const r = await send(msg)
		if (r.kind === 'state') {
			state.value = r.state
			error.value = null
			return
		}
		error.value =
			r.kind === 'failed'
				? "Couldn't save that change."
				: 'Lost contact with this tab. Reload it to keep tuning.'
		// Re-render from the last known state: a toggle or slider the user just moved
		// holds its new DOM position until Preact re-renders, which would otherwise
		// show a change that never happened.
		if (state.value) state.value = { ...state.value }
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
					<p className="state__msg">{emptyMessage(initial.value)}</p>
				</div>
			</div>
		)
	}

	const controlsDisabled = !s.globalEnabled || !s.enabled
	const notice = s.globalEnabled ? AUDIO_NOTICE[s.audio] : undefined

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
				{error.value && (
					<p className="notice notice--error" role="alert">
						{error.value}
					</p>
				)}
				{notice && (
					<output className={`notice${notice.error ? ' notice--error' : ''}`}>{notice.text}</output>
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
