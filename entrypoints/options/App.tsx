import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { storage } from 'wxt/utils/storage'

import { formatSemitones } from '@/lib/format'
import { Logo, PowerIcon, FilmIcon, TrashIcon } from '@/lib/icons'
import type { VideoSetting } from '@/lib/settings'
import {
	globalEnabled,
	listVideoSettings,
	removeVideoSetting,
	clearVideoSettings,
	watchVideoSettings,
} from '@/lib/storage'

function App() {
	const global = useSignal(true)
	const videos = useSignal<Record<string, VideoSetting>>({})
	const error = useSignal<string | null>(null)
	/** "Clear all" was pressed once and waits for the second, confirming press. */
	const confirmingClear = useSignal(false)
	const cancelRef = useRef<HTMLButtonElement>(null)
	const clearRef = useRef<HTMLButtonElement>(null)

	async function refresh() {
		const [g, v] = await Promise.all([globalEnabled.getValue(), listVideoSettings()])
		global.value = g
		videos.value = v
	}

	// Mount-once load; refresh only writes stable signals. The watchers keep this
	// page honest while it sits open — the popup edits the same storage, so without
	// them the master switch here can read "On" while the popup just turned it off.
	useEffect(() => {
		void reload('initial load')
		// One re-read per change rather than per-item watchers writing individual
		// signals: this page is edited rarely, extra storage reads cost nothing, and a
		// single path means the displayed state always comes from storage.
		const unwatchers = [
			storage.watch('local:globalEnabled', () => void reload('globalEnabled changed')),
			watchVideoSettings(() => void reload('video settings changed')),
		]
		return () => unwatchers.forEach((off) => off())
	}, [])

	/**
	 * Re-read storage into the signals, reporting instead of silently leaving the
	 * initial defaults on screen — those defaults read as "master switch on, no
	 * saved videos", which is indistinguishable from a wiped configuration.
	 */
	async function reload(reason: string): Promise<boolean> {
		try {
			await refresh()
			error.value = null
			return true
		} catch (err) {
			console.error(`[modulate] options reload failed (${reason})`, err)
			error.value = 'Could not read your settings. Reload this page to try again.'
			return false
		}
	}

	/**
	 * Apply an optimistic signal update, then persist. On failure roll the signal
	 * back from storage — leaving it would show the user a switch position that
	 * storage never accepted, which the content scripts then contradict at playback
	 * time.
	 */
	async function persist(work: () => Promise<void>): Promise<void> {
		try {
			await work()
			error.value = null
		} catch (err) {
			console.error('[modulate] options write failed', err)
			// Report after the rollback read: a successful reload clears the error, which
			// would otherwise wipe this message the instant it appeared. A failed reload
			// keeps its own, more urgent, "could not read" message instead.
			if (await reload('rollback')) error.value = 'Could not save that change.'
		}
	}

	function toggleGlobal(value: boolean) {
		void persist(async () => {
			global.value = value
			await globalEnabled.setValue(value)
		})
	}

	const videoEntries = Object.entries(videos.value)
	// Nothing left to clear (removed one by one, or from another page).
	if (videoEntries.length === 0) confirmingClear.value = false

	// Focus follows the question: onto the safe answer when it is asked, back to the
	// button that asked it when it is dismissed.
	const asked = useRef(false)
	useEffect(() => {
		if (confirmingClear.value) cancelRef.current?.focus()
		else if (asked.current) clearRef.current?.focus()
		asked.current = confirmingClear.value
	}, [confirmingClear.value])

	const clearQuestion = `Remove ${
		videoEntries.length === 1 ? 'the saved video' : `all ${videoEntries.length} saved videos`
	}? This can't be undone.`

	function dismissOnEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') confirmingClear.value = false
	}

	function clearAll() {
		confirmingClear.value = false
		void persist(() => clearVideoSettings())
	}

	return (
		<div className="options">
			<header className="o-head">
				<span className="o-mark">
					<Logo />
				</span>
				<div>
					<h1 className="o-title">
						Modulate
						<span className="o-ver">v{browser.runtime.getManifest().version}</span>
					</h1>
					<p className="o-subtitle">Settings &amp; saved videos</p>
				</div>
			</header>

			{error.value && (
				<p className="o-error" role="alert">
					{error.value}
				</p>
			)}

			<section className="o-section">
				<div className="o-section__head">
					<span className="o-section__icon">
						<PowerIcon />
					</span>
					<div>
						<h2 className="o-section__title">General</h2>
						<p className="o-section__desc">Master switch for every video.</p>
					</div>
				</div>
				<div className="card">
					<div className="row">
						<div className="row__text">
							<span className="row__label">Enable Modulate</span>
							<span className="row__desc">Turn all pitch and tempo processing on or off.</span>
						</div>
						<label className="toggle">
							<input
								type="checkbox"
								aria-label="Enable Modulate"
								checked={global.value}
								onChange={(e) => toggleGlobal(e.currentTarget.checked)}
							/>
							<span className="toggle__track">
								<span className="toggle__thumb" />
							</span>
						</label>
					</div>
				</div>
			</section>

			<section className="o-section">
				<div className="o-section__head">
					<span className="o-section__icon">
						<FilmIcon />
					</span>
					<div>
						<h2 className="o-section__title">Saved Videos</h2>
						<p className="o-section__desc">
							Per-video pitch and tempo{videoEntries.length > 0 ? ` · ${videoEntries.length}` : ''}.
						</p>
					</div>
				</div>
				<div className="card">
					{videoEntries.length === 0 ? (
						<div className="o-empty">
							<FilmIcon className="o-empty__icon" />
							<p>No saved videos yet. Tune any YouTube video and it will appear here.</p>
						</div>
					) : (
						<>
							<div className="vlist">
								{videoEntries.map(([id, s]) => {
									const label = s.title ?? id
									return (
										<div className="vrow" key={id}>
											<a
												className="vrow__main"
												href={`https://www.youtube.com/watch?v=${id}`}
												target="_blank"
												rel="noreferrer"
												title={label}
												aria-label={`Open ${label} on YouTube`}
											>
												<img
													className="vrow__thumb"
													src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`}
													alt=""
													loading="lazy"
													onError={(e) => {
														e.currentTarget.style.visibility = 'hidden'
													}}
												/>
												<div className="vrow__info">
													<span className="vrow__id">{label}</span>
													<div className="vrow__chips">
														<span className="chip">{formatSemitones(s.semitones)} st</span>
														<span className="chip">{s.tempo.toFixed(2)}×</span>
														{!s.enabled && <span className="chip chip--off">off</span>}
													</div>
												</div>
											</a>
											<button
												className="icon-btn"
												// Names the row, not just the action: a screen reader on a list of
												// twenty would otherwise announce twenty buttons called "Remove".
												aria-label={`Remove ${label}`}
												onClick={() =>
													// No re-read here: the storage watcher does it, and folding
													// it in would report a failed read as a failed save.
													void persist(() => removeVideoSetting(id))
												}
											>
												<TrashIcon />
											</button>
										</div>
									)
								})}
							</div>
							{confirmingClear.value ? (
								<div className="vrow-actions">
									<span id="clear-question" className="vrow-actions__question">
										{clearQuestion}
									</span>
									<button
										ref={cancelRef}
										className="btn"
										aria-describedby="clear-question"
										onClick={() => (confirmingClear.value = false)}
										onKeyDown={dismissOnEscape}
									>
										Cancel
									</button>
									<button
										className="btn btn--danger"
										aria-describedby="clear-question"
										onClick={clearAll}
										onKeyDown={dismissOnEscape}
									>
										Remove all
									</button>
								</div>
							) : (
								<div className="vrow-actions">
									<button
										ref={clearRef}
										className="btn btn--danger"
										onClick={() => (confirmingClear.value = true)}
									>
										Clear all
									</button>
								</div>
							)}
						</>
					)}
				</div>
			</section>
		</div>
	)
}

export default App
