/**
 * On-demand content-script injection.
 *
 * Why this exists: manifest-declared content_scripts inject on PAGE LOAD
 * only. A Calendar tab that was already open when the extension was
 * installed, updated, or reloaded has no live script, and Calendar is an SPA
 * — in-app navigation never triggers a fresh injection. The result was a tab
 * that looked fine and silently ignored every click until manually refreshed.
 *
 * The Phase 6 orphan teardown made that failure quieter (clean exit instead
 * of console spam) without making it shorter, so teardown and re-injection
 * ship together: the orphan stands down, and this module puts a live script
 * back in its place.
 *
 * Strategy: PROBE, THEN INJECT. Ping the tab; inject only if nothing answers.
 * A dead port and a missing script are indistinguishable from here, which is
 * fine — both mean "inject". This also means no bookkeeping in the worker,
 * which is essential: the worker dies and forgets, so any state it kept about
 * which tabs are "done" would be wrong within seconds.
 */

import { MSG } from '../shared/messages.js';
import { debugLog } from '../shared/debug.js';

const CONTENT_FILE = 'content/calendar.js';
const CALENDAR_ORIGIN = 'https://calendar.google.com/';

export function isCalendarUrl(url) {
  return typeof url === 'string' && url.startsWith(CALENDAR_ORIGIN);
}

/** @returns {Promise<boolean>} true iff a live script answered. */
async function ping(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING_CONTENT });
    return Boolean(response?.alive);
  } catch {
    // "Receiving end does not exist" — no script, or an orphaned one whose
    // port is dead. Either way: not live.
    return false;
  }
}

/**
 * Guarantee a live content script in one tab.
 *
 * Idempotent on both sides: this pings first, and the script itself no-ops
 * when a live instance already owns the frame (see the SENTINEL guard in
 * content/calendar.js). Belt and braces on purpose — a race between two
 * ensure calls must not double-register listeners and send every event twice.
 *
 * @returns {Promise<{alive: boolean, injected: boolean, reason?: string}>}
 */
export async function ensureContentScript(tabId, url) {
  if (!isCalendarUrl(url)) return { alive: false, injected: false, reason: 'not-calendar' };

  if (await ping(tabId)) return { alive: true, injected: false };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [CONTENT_FILE],
    });
  } catch (err) {
    // Expected for tabs that reject injection: chrome:// pages, the Web
    // Store, a tab mid-navigation, a tab that closed under us. Never surfaced
    // to the user — the panel reports "not listening" and offers retry.
    debugLog('injection failed for tab', tabId, err?.message ?? err);
    return { alive: false, injected: false, reason: String(err?.message ?? err) };
  }

  // Confirm rather than assume: executeScript resolving means the file ran,
  // not that our listener is attached (the sentinel path may have no-oped).
  const alive = await ping(tabId);
  debugLog('injected content script into tab', tabId, '-> alive:', alive);
  return { alive, injected: true };
}

/**
 * Sweep every open Calendar tab. Runs on install/update/extension-reload,
 * which is the case that produced the original bug: tabs open BEFORE the
 * extension existed in its current form.
 *
 * Not sufficient on its own — onInstalled does not fire in every situation
 * where a stale tab can exist (a worker restart, a tab restored from a
 * previous session), which is why the panel-open path calls ensure too. The
 * two are backstops for each other; neither covers everything alone.
 */
export async function injectIntoOpenCalendarTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${CALENDAR_ORIGIN}*` });
  } catch (err) {
    debugLog('tab query failed', err?.message ?? err);
    return;
  }
  await Promise.allSettled(tabs.map((tab) => ensureContentScript(tab.id, tab.url)));
  debugLog('swept', tabs.length, 'calendar tab(s)');
}

/** Ensure the script in the active tab of the focused window (panel path). */
export async function ensureActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { alive: false, injected: false, reason: 'no-active-tab' };
    const result = await ensureContentScript(tab.id, tab.url);
    return { ...result, tabId: tab.id, isCalendar: isCalendarUrl(tab.url) };
  } catch (err) {
    debugLog('ensureActiveTab failed', err?.message ?? err);
    return { alive: false, injected: false, reason: String(err?.message ?? err) };
  }
}
