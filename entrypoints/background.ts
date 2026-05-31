import type { BadgeMessage, PopupMessage } from '@/lib/messaging';
import { TEMPO_STEP } from '@/lib/storage';

/** Keyboard `commands` → the `PopupMessage` to send the active tab's content script. */
const COMMAND_MESSAGES: Record<string, PopupMessage> = {
  'modulate-pitch-up': { type: 'NUDGE_SEMITONES', delta: 1 },
  'modulate-pitch-down': { type: 'NUDGE_SEMITONES', delta: -1 },
  'modulate-tempo-up': { type: 'NUDGE_TEMPO', delta: TEMPO_STEP },
  'modulate-tempo-down': { type: 'NUDGE_TEMPO', delta: -TEMPO_STEP },
};

export default defineBackground(() => {
  // MV3 Chrome exposes `browser.action`; MV2 Firefox exposes `browserAction`.
  const action = browser.action ?? browser.browserAction;
  const ACCENT = '#646cff';

  function format(n: number): string {
    if (n === 0) return '0';
    return `${n > 0 ? '+' : ''}${n}`;
  }

  // Keyboard shortcuts: forward to the active tab's content script. Errors mean
  // the tab has no content script (not YouTube) — ignore.
  browser.commands?.onCommand.addListener(async (command) => {
    const msg = COMMAND_MESSAGES[command];
    if (!msg) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return;
    try {
      await browser.tabs.sendMessage(tab.id, msg);
    } catch {
      // No content script in this tab.
    }
  });

  // Toolbar badge: the content script reports its effective pitch/tempo per apply.
  browser.runtime.onMessage.addListener((message: BadgeMessage, sender) => {
    if (message?.type !== 'MODULATE_BADGE') return;
    const tabId = sender.tab?.id;
    if (tabId == null || !action) return;

    const text =
      message.semitones !== 0
        ? format(message.semitones)
        : message.tempo !== 1
          ? '♪'
          : '';
    action.setBadgeText({ tabId, text });
    action.setBadgeBackgroundColor?.({ tabId, color: ACCENT });
  });
});
