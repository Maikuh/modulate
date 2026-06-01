import { useCallback, useEffect, useState } from 'preact/hooks'

import { formatSemitones } from '@/lib/format'
import { Logo, PowerIcon, SlidersIcon, FilmIcon, TrashIcon } from '@/lib/icons'
import {
	globalEnabled,
	audioQuality,
	DEFAULT_AUDIO_QUALITY,
	type AudioQuality,
	type VideoSetting,
	listVideoSettings,
	removeVideoSetting,
	clearVideoSettings,
} from '@/lib/storage'

function App() {
	const [global, setGlobal] = useState(true)
	const [quality, setQuality] = useState<AudioQuality>(DEFAULT_AUDIO_QUALITY)
	const [videos, setVideos] = useState<Record<string, VideoSetting>>({})

	const refresh = useCallback(async () => {
		const [g, q, v] = await Promise.all([
			globalEnabled.getValue(),
			audioQuality.getValue(),
			listVideoSettings(),
		])
		setGlobal(g)
		setQuality(q)
		setVideos(v)
	}, [])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const toggleGlobal = useCallback(async (value: boolean) => {
		setGlobal(value)
		await globalEnabled.setValue(value)
	}, [])

	const patchQuality = useCallback(async (partial: Partial<AudioQuality>) => {
		setQuality((prev) => {
			const next = { ...prev, ...partial }
			void audioQuality.setValue(next)
			return next
		})
	}, [])

	const videoIds = Object.keys(videos)

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
								checked={global}
								onChange={(e) => void toggleGlobal(e.currentTarget.checked)}
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
							costs CPU. Use 0 for auto-calculated timing.
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
								min={0}
								max={40}
								step={1}
								value={quality.overlapMs}
								onChange={(e) => void patchQuality({ overlapMs: Number(e.currentTarget.value) })}
							/>
							<span className="quality-value">{quality.overlapMs}</span>
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
								checked={quality.quickSeek}
								onChange={(e) => void patchQuality({ quickSeek: e.currentTarget.checked })}
							/>
							<span className="toggle__track">
								<span className="toggle__thumb" />
							</span>
						</label>
					</div>

					<div className="row">
						<div className="row__text">
							<span className="row__label">Sequence (ms)</span>
							<span className="row__desc">Window length. 0 = auto.</span>
						</div>
						<input
							type="number"
							className="num"
							aria-label="Sequence (ms)"
							min={0}
							value={quality.sequenceMs}
							onChange={(e) => void patchQuality({ sequenceMs: Number(e.currentTarget.value) })}
						/>
					</div>

					<div className="row">
						<div className="row__text">
							<span className="row__label">Seek window (ms)</span>
							<span className="row__desc">Search range for best overlap. 0 = auto.</span>
						</div>
						<input
							type="number"
							className="num"
							aria-label="Seek window (ms)"
							min={0}
							value={quality.seekWindowMs}
							onChange={(e) => void patchQuality({ seekWindowMs: Number(e.currentTarget.value) })}
						/>
					</div>

					<div className="row">
						<div className="row__text">
							<span className="row__label">Restore defaults</span>
							<span className="row__desc">Reset every quality knob to its recommended value.</span>
						</div>
						<button className="btn" onClick={() => void patchQuality(DEFAULT_AUDIO_QUALITY)}>
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
									const s = videos[id]
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
												aria-label="Remove"
												onClick={async () => {
													await removeVideoSetting(id)
													await refresh()
												}}
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
									onClick={async () => {
										await clearVideoSettings()
										await refresh()
									}}
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
