import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { storage } from 'wxt/utils/storage'

import {
	DEFAULT_AUDIO_QUALITY,
	MIN_OVERLAP_MS,
	MAX_OVERLAP_MS,
	clampOverlapMs,
	type AudioQuality,
} from '@/lib/audioQuality'
import { formatSemitones } from '@/lib/format'
import { Logo, PowerIcon, SlidersIcon, FilmIcon, TrashIcon } from '@/lib/icons'
import {
	globalEnabled,
	audioQuality,
	type VideoSetting,
	listVideoSettings,
	removeVideoSetting,
	clearVideoSettings,
} from '@/lib/storage'

function App() {
	const global = useSignal(true)
	const quality = useSignal<AudioQuality>(DEFAULT_AUDIO_QUALITY)
	const videos = useSignal<Record<string, VideoSetting>>({})
	const error = useSignal<string | null>(null)

	async function refresh() {
		const [g, q, v] = await Promise.all([
			globalEnabled.getValue(),
			audioQuality.getValue(),
			listVideoSettings(),
		])
		global.value = g
		quality.value = q
		videos.value = v
	}

	// Mount-once load; refresh only writes stable signals. The watchers keep this
	// page honest while it sits open — the popup edits the same storage, so without
	// them the master switch here can read "On" while the popup just turned it off.
	useEffect(() => {
		void reload('initial load')
		// One re-read per change rather than per-item watchers writing individual
		// signals: this page is edited rarely, three extra storage reads cost nothing,
		// and a single path means the displayed state always comes from storage.
		const keys = ['local:globalEnabled', 'local:audioQuality', 'local:videoSettings'] as const
		const unwatchers = keys.map((key) => storage.watch(key, () => void reload(`${key} changed`)))
		return () => unwatchers.forEach((off) => off())
	}, [])

	/**
	 * Re-read storage into the signals, reporting instead of silently leaving the
	 * initial defaults on screen — those defaults read as "master switch on, no
	 * saved videos", which is indistinguishable from a wiped configuration.
	 */
	async function reload(reason: string): Promise<void> {
		try {
			await refresh()
			error.value = null
		} catch (err) {
			console.error(`[modulate] options reload failed (${reason})`, err)
			error.value = 'Could not read your settings. Reload this page to try again.'
		}
	}

	/**
	 * Apply an optimistic signal update, then persist. On failure roll the signal
	 * back from storage — leaving it would show the user a switch position or a
	 * quality value that storage never accepted, which the content scripts then
	 * contradict at playback time.
	 */
	async function persist(work: () => Promise<void>): Promise<void> {
		try {
			await work()
			error.value = null
		} catch (err) {
			console.error('[modulate] options write failed', err)
			error.value = 'Could not save that change.'
			await reload('rollback')
		}
	}

	function toggleGlobal(value: boolean) {
		void persist(async () => {
			global.value = value
			await globalEnabled.setValue(value)
		})
	}

	function patchQuality(partial: Partial<AudioQuality>) {
		void persist(async () => {
			const next = { ...quality.value, ...partial }
			quality.value = next
			await audioQuality.setValue(next)
		})
	}

	const videoIds = Object.keys(videos.value)

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
						<SlidersIcon />
					</span>
					<div>
						<h2 className="o-section__title">Audio Quality</h2>
						<p className="o-section__desc">
							WSOLA time-stretch tuning. Higher overlap reduces artifacts at extreme shifts but
							costs CPU. Window timing is auto-calculated.
						</p>
					</div>
				</div>
				<div className="card">
					<div className="row">
						<div className="row__text">
							<span className="row__label">Overlap (ms)</span>
							<span className="row__desc">Crossfade between processing windows.</span>
						</div>
						<div className="quality-control">
							<input
								type="range"
								className="slider"
								aria-label="Overlap (ms)"
								min={MIN_OVERLAP_MS}
								max={MAX_OVERLAP_MS}
								step={1}
								value={quality.value.overlapMs}
								onChange={(e) =>
									patchQuality({ overlapMs: clampOverlapMs(Number(e.currentTarget.value)) })
								}
							/>
							<span className="quality-value">{quality.value.overlapMs}</span>
						</div>
					</div>

					<div className="row">
						<div className="row__text">
							<span className="row__label">Quick seek</span>
							<span className="row__desc">Faster processing, slightly more artifacts.</span>
						</div>
						<label className="toggle">
							<input
								type="checkbox"
								aria-label="Quick seek"
								checked={quality.value.quickSeek}
								onChange={(e) => patchQuality({ quickSeek: e.currentTarget.checked })}
							/>
							<span className="toggle__track">
								<span className="toggle__thumb" />
							</span>
						</label>
					</div>

					<div className="row">
						<div className="row__text">
							<span className="row__label">Restore defaults</span>
							<span className="row__desc">Reset every quality knob to its recommended value.</span>
						</div>
						<button className="btn" onClick={() => patchQuality(DEFAULT_AUDIO_QUALITY)}>
							Restore
						</button>
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
							Per-video pitch and tempo{videoIds.length > 0 ? ` · ${videoIds.length}` : ''}.
						</p>
					</div>
				</div>
				<div className="card">
					{videoIds.length === 0 ? (
						<div className="o-empty">
							<FilmIcon className="o-empty__icon" />
							<p>No saved videos yet. Tune any YouTube video and it will appear here.</p>
						</div>
					) : (
						<>
							<div className="vlist">
								{videoIds.map((id) => {
									const s = videos.value[id]
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
													void persist(async () => {
														await removeVideoSetting(id)
														await refresh()
													})
												}
											>
												<TrashIcon />
											</button>
										</div>
									)
								})}
							</div>
							<div className="vrow-actions">
								<button
									className="btn btn--danger"
									onClick={() =>
										void persist(async () => {
											await clearVideoSettings()
											await refresh()
										})
									}
								>
									Clear all
								</button>
							</div>
						</>
					)}
				</div>
			</section>
		</div>
	)
}

export default App
