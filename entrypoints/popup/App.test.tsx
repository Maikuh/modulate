import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { PlayerState, PopupMessage } from '@/lib/messaging';
import App from './App';

const activeState: PlayerState = {
  videoId: 'abc',
  globalEnabled: true,
  enabled: true,
  semitones: 0,
  tempo: 1,
};

/** Spy on tabs.query/sendMessage; sendMessage echoes the given state (or rejects). */
function mockTabs(state: PlayerState | null) {
  vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 1 }] as any);
  const sendMessage = vi
    .spyOn(browser.tabs, 'sendMessage')
    .mockImplementation((async () =>
      state === null ? Promise.reject(new Error('no content script')) : state) as any);
  return sendMessage;
}

// WxtVitest runs without DOM isolation; scope queries to this render's container.
function renderApp() {
  return within(render(<App />).container);
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('popup App', () => {
  it('renders the player state after the mount GET_STATE', async () => {
    mockTabs(activeState);
    const view = renderApp();
    expect(await view.findByText('Pitch')).toBeInTheDocument();
    expect(view.getByText('Tempo')).toBeInTheDocument();
  });

  it('shows the empty state when no content script responds', async () => {
    mockTabs(null);
    const view = renderApp();
    expect(await view.findByText(/Open a YouTube video/i)).toBeInTheDocument();
  });

  it('shows the empty state when videoId is null', async () => {
    mockTabs({ ...activeState, videoId: null });
    const view = renderApp();
    expect(await view.findByText(/Open a YouTube video/i)).toBeInTheDocument();
  });

  it('dispatches NUDGE_SEMITONES on the pitch increase button', async () => {
    const sendMessage = mockTabs(activeState);
    const view = renderApp();
    await view.findByText('Pitch');
    sendMessage.mockClear();
    await userEvent.click(view.getByRole('button', { name: 'Increase Pitch' }));
    expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({
      type: 'NUDGE_SEMITONES',
      delta: 1,
    });
  });

  it('dispatches SET_GLOBAL_ENABLED from the master switch', async () => {
    const sendMessage = mockTabs(activeState);
    const view = renderApp();
    await view.findByText('Pitch');
    sendMessage.mockClear();
    await userEvent.click(view.getByLabelText('Master switch'));
    expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({
      type: 'SET_GLOBAL_ENABLED',
      enabled: false,
    });
  });

  it('dispatches RESET from the reset button', async () => {
    const sendMessage = mockTabs(activeState);
    const view = renderApp();
    await view.findByText('Pitch');
    sendMessage.mockClear();
    await userEvent.click(view.getByRole('button', { name: /reset/i }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][1] as PopupMessage).toEqual({ type: 'RESET' });
  });
});
