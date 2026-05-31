import { useCallback, useEffect, useState } from 'react';
import {
  globalEnabled,
  audioQuality,
  DEFAULT_AUDIO_QUALITY,
  type AudioQuality,
  type VideoSetting,
  listVideoSettings,
  removeVideoSetting,
  clearVideoSettings,
} from '@/lib/storage';
import './App.css';

function formatSemitones(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : ''}${n}`;
}

function App() {
  const [global, setGlobal] = useState(true);
  const [quality, setQuality] = useState<AudioQuality>(DEFAULT_AUDIO_QUALITY);
  const [videos, setVideos] = useState<Record<string, VideoSetting>>({});

  const refresh = useCallback(async () => {
    const [g, q, v] = await Promise.all([
      globalEnabled.getValue(),
      audioQuality.getValue(),
      listVideoSettings(),
    ]);
    setGlobal(g);
    setQuality(q);
    setVideos(v);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchQuality = useCallback(
    async (partial: Partial<AudioQuality>) => {
      const next = { ...quality, ...partial };
      setQuality(next);
      await audioQuality.setValue(next);
    },
    [quality],
  );

  const toggleGlobal = useCallback(async (value: boolean) => {
    setGlobal(value);
    await globalEnabled.setValue(value);
  }, []);

  const videoIds = Object.keys(videos);

  return (
    <main className="options">
      <header>
        <h1>Modulate</h1>
        <p className="muted">Settings &amp; saved transpositions</p>
      </header>

      <section>
        <h2>General</h2>
        <label className="switch">
          <input
            type="checkbox"
            checked={global}
            onChange={(e) => void toggleGlobal(e.target.checked)}
          />
          <span>Enabled globally</span>
        </label>
      </section>

      <section>
        <h2>Audio quality</h2>
        <p className="muted hint">
          WSOLA time-stretch tuning. Higher overlap and full seek reduce artifacts
          at extreme shifts but cost CPU and a little smearing. Use 0 for
          auto-calculated timing.
        </p>
        <div className="field">
          <label htmlFor="overlap">Overlap (ms): {quality.overlapMs}</label>
          <input
            id="overlap"
            type="range"
            min={0}
            max={40}
            step={1}
            value={quality.overlapMs}
            onChange={(e) => void patchQuality({ overlapMs: Number(e.target.value) })}
          />
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={quality.quickSeek}
            onChange={(e) => void patchQuality({ quickSeek: e.target.checked })}
          />
          <span>Quick seek (faster, slightly more artifacts)</span>
        </label>
        <div className="field-row">
          <div className="field">
            <label htmlFor="sequence">Sequence (ms)</label>
            <input
              id="sequence"
              type="number"
              min={0}
              value={quality.sequenceMs}
              onChange={(e) => void patchQuality({ sequenceMs: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="seek">Seek window (ms)</label>
            <input
              id="seek"
              type="number"
              min={0}
              value={quality.seekWindowMs}
              onChange={(e) => void patchQuality({ seekWindowMs: Number(e.target.value) })}
            />
          </div>
        </div>
        <button
          className="secondary"
          onClick={() => void patchQuality(DEFAULT_AUDIO_QUALITY)}
        >
          Restore defaults
        </button>
      </section>

      <section>
        <div className="section-head">
          <h2>Saved videos ({videoIds.length})</h2>
          {videoIds.length > 0 && (
            <button
              className="secondary"
              onClick={async () => {
                await clearVideoSettings();
                await refresh();
              }}
            >
              Clear all
            </button>
          )}
        </div>
        {videoIds.length === 0 ? (
          <p className="muted">No per-video settings saved.</p>
        ) : (
          <ul className="rows">
            {videoIds.map((id) => {
              const s = videos[id];
              return (
                <li key={id} className="row">
                  <a
                    className="row-id"
                    href={`https://www.youtube.com/watch?v=${id}`}
                    target="_blank"
                    rel="noreferrer"
                    title={id}
                  >
                    {id}
                  </a>
                  <span className="row-meta">
                    {formatSemitones(s.semitones)} st · {s.tempo.toFixed(2)}×
                    {s.enabled ? '' : ' · off'}
                  </span>
                  <button
                    className="link danger"
                    onClick={async () => {
                      await removeVideoSetting(id);
                      await refresh();
                    }}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
