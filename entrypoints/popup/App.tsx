import { useCallback, useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PlayerState, PopupMessage } from '@/lib/messaging';
import { MIN_SEMITONES, MAX_SEMITONES } from '@/lib/storage';
import './App.css';

/** Send a message to the content script in the active tab; null if none responds. */
async function send(msg: PopupMessage): Promise<PlayerState | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return null;
  try {
    return (await browser.tabs.sendMessage(tab.id, msg)) as PlayerState;
  } catch {
    // No content script in this tab (not a YouTube page).
    return null;
  }
}

function formatSemitones(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : ''}${n}`;
}

function App() {
  const [state, setState] = useState<PlayerState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    send({ type: 'GET_STATE' })
      .then(setState)
      .finally(() => setLoading(false));
  }, []);

  const dispatch = useCallback(async (msg: PopupMessage) => {
    const s = await send(msg);
    if (s) setState(s);
  }, []);

  if (loading) {
    return (
      <main className="popup">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const onYouTube = state?.videoId != null;
  const global = state?.globalEnabled ?? true;
  const videoEnabled = state?.enabled ?? true;
  const semitones = state?.semitones ?? 0;
  const active = onYouTube && global && videoEnabled;

  return (
    <main className="popup">
      <header className="header">
        <h1>Modulate</h1>
        <label className="switch" title="Master switch for all videos">
          <input
            type="checkbox"
            checked={global}
            onChange={(e) =>
              dispatch({ type: 'SET_GLOBAL_ENABLED', enabled: e.target.checked })
            }
          />
          <span>Enabled globally</span>
        </label>
      </header>

      {!onYouTube ? (
        <p className="muted empty">Open a YouTube video to transpose its audio.</p>
      ) : (
        <>
          <label className="switch" title="Enable for this video only">
            <input
              type="checkbox"
              checked={videoEnabled}
              disabled={!global}
              onChange={(e) =>
                dispatch({ type: 'SET_VIDEO_ENABLED', enabled: e.target.checked })
              }
            />
            <span>Enabled for this video</span>
          </label>

          <div className={`stepper ${active ? '' : 'dim'}`}>
            <button
              aria-label="Down a semitone"
              disabled={!active || semitones <= MIN_SEMITONES}
              onClick={() => dispatch({ type: 'SET_SEMITONES', semitones: semitones - 1 })}
            >
              <Minus size={22} strokeWidth={2.5} aria-hidden />
            </button>
            <div className="readout">
              <span className="value">{formatSemitones(semitones)}</span>
              <span className="unit">semitones</span>
            </div>
            <button
              aria-label="Up a semitone"
              disabled={!active || semitones >= MAX_SEMITONES}
              onClick={() => dispatch({ type: 'SET_SEMITONES', semitones: semitones + 1 })}
            >
              <Plus size={22} strokeWidth={2.5} aria-hidden />
            </button>
          </div>

          <button
            className="reset"
            disabled={!active || semitones === 0}
            onClick={() => dispatch({ type: 'RESET' })}
          >
            Reset
          </button>
        </>
      )}
    </main>
  );
}

export default App;
