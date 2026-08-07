/**
 * Content script for calendar.google.com — event-click extractor.
 *
 * Extraction strategy (deliberate): we do NOT scrape titles, attendees, or
 * descriptions out of Calendar's obfuscated, A/B-tested DOM. The only thing
 * we take from the page is the event *pointer* carried by each chip's
 * `data-eventid`; the background worker fetches ground truth from the
 * Calendar API using the calendar.readonly scope we already hold.
 *
 * What we take from that pointer changed after the 404 bug: the EVENT ID
 * only. Google supplies a truncated calendar segment in the DOM
 * ("user@m" instead of "user@gmail.com"), so the worker addresses
 * events.get against 'primary' unless the segment independently validates
 * as a complete calendar identifier. See src/shared/eventId.js for the full
 * write-up — that module owns decode and validation, and the worker
 * re-validates whatever we send.
 *
 * Build note: compiled by a SEPARATE Vite pass into a self-contained IIFE
 * (dist/content/calendar.js) because MV3 content scripts cannot be ES
 * modules. The imports below are inlined at build time.
 */

import { MSG } from '../shared/messages.js';
import { decodeEventChip, isRecurringInstanceId } from '../shared/eventId.js';
import { debugLog } from '../shared/debug.js';

// Suppress duplicate sends: one physical click can bubble through several
// nested [data-eventid] wrappers, and users double-click chips.
const DEDUPE_WINDOW_MS = 1500;
let lastKey = '';
let lastSentAt = 0;

/**
 * Orphan handling.
 *
 * Reloading or updating the extension kills the runtime port of every content
 * script already injected into open tabs, but the script itself keeps running
 * and keeps receiving DOM events. The next chrome.runtime call then throws
 * "Extension context invalidated" — once per click, forever, filling the
 * errors page during development.
 *
 * `chrome.runtime?.id` is the conventional liveness probe: it reads undefined
 * once the context is gone. An orphaned script cannot reconnect (there is no
 * re-bind API), so the only correct response is to remove our listeners and
 * go quiet. The page keeps working normally; the freshly injected copy in the
 * next page load takes over.
 */
function isContextAlive() {
  // Accessing chrome.runtime.id can itself throw in a torn-down context.
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  document.removeEventListener('click', onClickCapture, true);
  try {
    chrome.runtime.onMessage.removeListener(onPing);
  } catch {
    // Already gone with the context — nothing to detach from.
  }
  // Release the sentinel so a re-injection can take this frame over. Without
  // this, an orphaned instance would keep the frame claimed and the tab would
  // stay inert until a manual reload — teardown without re-injection is only
  // half a fix.
  if (globalThis[SENTINEL]?.teardown === teardown) delete globalThis[SENTINEL];
  // Nothing else to release: this script holds no MutationObserver, timer or
  // debounce — dedupe state is two module-level values. If a future version
  // adds any, disconnect/clear them HERE.
  console.debug('[mpf] extension context invalidated; content script detached');
}

/**
 * Liveness probe answered for the background's ping. Its mere existence is
 * the signal — the worker treats "no response" and "no script" identically,
 * because from its side they are the same thing and both mean "inject".
 */
function onPing(message, _sender, sendResponse) {
  if (message?.type !== MSG.PING_CONTENT) return false;
  sendResponse({ alive: true, url: location.href });
  return false; // responded synchronously
}

function onClickCapture(event) {
  if (!isContextAlive()) {
    teardown();
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) return;

  const chip = target.closest('[data-eventid]');
  if (!chip) return;

  const raw = chip.getAttribute('data-eventid');
  const parsed = decodeEventChip(raw);

  if (parsed.error) {
    // Tasks, reminders and birthday chips land here routinely — silent by
    // default, visible when debugging a genuinely missed click.
    debugLog('chip ignored:', parsed.error, { raw, decoded: parsed.decoded });
    return;
  }

  debugLog('chip decoded:', {
    raw,
    rawLength: raw.length,
    decoded: parsed.decoded,
    eventId: parsed.eventId,
    recurringInstance: isRecurringInstanceId(parsed.eventId),
    rawTrailer: parsed.rawTrailer,
    // The load-bearing line for this class of bug: when true, Google gave us
    // a calendar segment we refused to trust and the worker will use
    // 'primary' instead.
    trailerRejected: parsed.trailerRejected,
    calendarIdSent: parsed.calendarId ?? '(primary)',
  });

  const key = `${parsed.calendarId ?? 'primary'}/${parsed.eventId}`;
  const now = Date.now();
  if (key === lastKey && now - lastSentAt < DEDUPE_WINDOW_MS) return;
  lastKey = key;
  lastSentAt = now;

  // sendMessage can throw SYNCHRONOUSLY when the context dies between the
  // liveness probe above and this call, so the try/catch is not redundant
  // with the promise rejection handler.
  try {
    chrome.runtime
      .sendMessage({
        type: MSG.EVENT_SELECTED,
        payload: {
          eventId: parsed.eventId,
          // null is meaningful: "we had nothing trustworthy — use primary".
          calendarId: parsed.calendarId,
          rawTrailer: parsed.rawTrailer,
          // Cheap optimistic title so the panel can show *something* while
          // the background round-trips to the Calendar API. Cosmetic only —
          // the API response is authoritative.
          hintTitle: (chip.textContent ?? '').trim().slice(0, 200),
        },
      })
      .catch(() => {
        // Async delivery failure — the worker may simply have been asleep.
        // Only an actually-dead context justifies detaching.
        if (!isContextAlive()) teardown();
      });
  } catch {
    teardown();
  }
}

/**
 * Single-instance guard for programmatic injection.
 *
 * This file is BOTH manifest-declared (on page load) and injected on demand
 * by the worker, so it can legitimately be asked to run twice in one frame.
 * Running twice would double the click listener and send every event
 * selection twice.
 *
 * The guard cannot be a bare boolean. The isolated world survives an
 * extension reload, so an ORPHANED instance would leave a stale flag set and
 * permanently block its own replacement — reproducing the exact "tab stays
 * inert until you refresh" bug this change exists to remove. Instead the
 * sentinel exposes the previous instance's own liveness check: an orphan
 * answers false (its `chrome.runtime` is dead) and gets retired, while a
 * genuinely live instance answers true and keeps the frame.
 */
const SENTINEL = '__mpfCalendarScript';
const previous = globalThis[SENTINEL];

if (previous?.alive?.()) {
  // A live instance already owns this frame; this injection is a duplicate.
  debugLog('content script already active in this frame — skipping duplicate');
} else {
  // Retire an orphaned predecessor so its listeners stop competing with ours.
  try {
    previous?.teardown?.();
  } catch {
    // A torn-down context can throw on its way out; not our problem.
  }
  globalThis[SENTINEL] = { alive: isContextAlive, teardown };

  // Capture phase: Calendar stopPropagation()s liberally in bubble phase, so
  // capture is the only reliable place to observe chip clicks. `document` is
  // the binding target on purpose — see the SPA note below.
  document.addEventListener('click', onClickCapture, true);
  chrome.runtime.onMessage.addListener(onPing);
  debugLog('content script active on', location.href);
}

/**
 * SPA-navigation note (verified by inspection, not by observer bookkeeping):
 * this script holds NO MutationObserver and therefore has nothing that can be
 * silently detached when Calendar swaps a view subtree. The single listener
 * is bound to `document`, which Calendar never replaces, and it matches chips
 * lazily at click time via `event.target.closest('[data-eventid]')` — so it
 * keeps working across day/week/month switches, search, settings, and week
 * paging without re-binding. If a future version adds an observer, bind it to
 * document.body and re-verify every one of those transitions.
 */
