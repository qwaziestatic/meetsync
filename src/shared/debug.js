/**
 * Storage-gated diagnostic logging.
 *
 * The decode path was flagged in Phase 2 as the extension's most fragile
 * assumption and has since broken twice (padding hypothesis, then the
 * truncated calendar segment). Its instrumentation stays in the codebase
 * rather than being deleted after each fix — but silent by default, because
 * a content script that logs on every calendar click is its own nuisance.
 *
 * Enable from any extension console (worker or panel DevTools):
 *   chrome.storage.local.set({ debugLogging: true })
 * Disable:
 *   chrome.storage.local.set({ debugLogging: false })
 *
 * Reads once at module load and then follows storage.onChanged, so toggling
 * takes effect without reloading the extension (the content script picks it
 * up on the next click, no page refresh needed).
 */

const FLAG_KEY = 'debugLogging';

let enabled = false;

chrome.storage.local
  .get(FLAG_KEY)
  .then((stored) => {
    enabled = Boolean(stored[FLAG_KEY]);
  })
  .catch(() => {
    /* storage unavailable in this context — stay silent */
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && FLAG_KEY in changes) {
    enabled = Boolean(changes[FLAG_KEY].newValue);
  }
});

export function debugLog(...args) {
  if (enabled) console.log('[mpf:debug]', ...args);
}

export function isDebugEnabled() {
  return enabled;
}
