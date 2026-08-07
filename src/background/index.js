/**
 * Meeting Pre-Flight Assistant — MV3 background service worker.
 *
 * Responsibilities (Phase 2):
 *   1. Side panel routing: panel is available only on calendar.google.com
 *      and meet.google.com tabs.
 *   2. Message routing (./router.js): the single entry point for the content
 *      script and the panel; auth (./auth.js) is only reachable through it.
 *
 * MV3 constraint that shapes this whole file: Chrome kills this worker after
 * ~30s idle and cold-starts it on the next event. Two consequences:
 *   - Every listener below is registered SYNCHRONOUSLY at top level, so
 *     Chrome can re-attach them on each restart. Never register listeners
 *     inside async callbacks or only in onInstalled.
 *   - No module-level state can be trusted to survive between events. Phase 3
 *     orchestration will persist per-step progress in chrome.storage.session
 *     so a mid-chain kill is resumable; nothing in Phase 1 needs that yet.
 */

// Side effect import: registers the chrome.runtime.onMessage listener at
// module evaluation time, i.e. synchronously on every worker (re)start.
import './router.js';
import { ensureContentScript, injectIntoOpenCalendarTabs, isCalendarUrl } from './injector.js';
import { selectEventFromUrl } from './router.js';

const PANEL_PATH = 'sidepanel.html';

// Exact-hostname allowlist. Deliberately not endsWith('.google.com') — that
// would also enable the panel on unrelated Google properties.
const PANEL_HOSTS = new Set(['calendar.google.com', 'meet.google.com']);

// ---------------------------------------------------------------------------
// 1. Side panel behavior
// ---------------------------------------------------------------------------

// Clicking the toolbar icon toggles the panel. This is the only way the panel
// opens in Phase 1: chrome.sidePanel.open() requires a user gesture, so the
// background can never programmatically pop it open on its own (flagged as a
// UX constraint for later phases — "auto-open when a meeting starts" is not
// possible without a gesture).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[mpf] setPanelBehavior failed:', err));

function isPanelUrl(url) {
  if (!url) return false;
  try {
    return PANEL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Enable/disable the panel for one tab based on its URL.
 *
 * Permission subtlety that makes this work WITHOUT the broad "tabs"
 * permission: tab.url is only populated for origins we hold host permissions
 * on (the two PANEL_HOSTS, plus the API endpoints). On every other site
 * tab.url is undefined, which isPanelUrl() maps to "disable" — exactly the
 * behavior we want, with least privilege.
 */
async function syncPanelForTab(tabId, url) {
  try {
    if (isPanelUrl(url)) {
      await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch {
    // Tab closed between the event and this call — routine race, not worth
    // console noise on every closed tab.
  }
}

// Navigation / SPA route changes. Gate on url or load-start to avoid churning
// setOptions on every favicon/title update event.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    syncPanelForTab(tabId, tab.url);
  }

  // Re-arm a Calendar tab that finished loading. ensureContentScript pings
  // first, so a tab that already has a live script costs one message and no
  // injection.
  if (changeInfo.status === 'complete' && isCalendarUrl(tab.url)) {
    ensureContentScript(tabId, tab.url);
  }

  // SPA route changes arrive as `changeInfo.url` without a page load. Two
  // jobs here: keep the script alive across in-app navigation, and read the
  // event id straight out of the URL as a backstop for the click path.
  if (changeInfo.url && isCalendarUrl(changeInfo.url)) {
    ensureContentScript(tabId, changeInfo.url);
    selectEventFromUrl(changeInfo.url, tabId);
  }
});

/**
 * Install, update, and "Reload" on chrome://extensions all land here. This is
 * the case that produced the manual-refresh bug: Calendar tabs that were
 * already open have no live script, and nothing else would ever inject one.
 */
chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenCalendarTabs();
});

// Browser restart with restored Calendar tabs — onInstalled does not fire.
chrome.runtime.onStartup.addListener(() => {
  injectIntoOpenCalendarTabs();
});

// Tab switches: covers tabs that existed before install or whose last
// onUpdated fired before the worker was alive.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    syncPanelForTab(tabId, tab.url);
  } catch {
    // Tab already gone — ignore.
  }
});
