/**
 * chrome.runtime message router — the ONLY entry point into background
 * functionality for the panel and content scripts. Replaces the Phase 1
 * `globalThis.__mpfAuth` dev hook.
 *
 * MV3 async-response rule this file lives by: chrome.runtime.onMessage does
 * NOT accept a returned Promise (that's a Firefox-ism). The listener must
 * call sendResponse and synchronously `return true` to keep the reply channel
 * open across the await. The wrapper at the bottom centralizes that so
 * handlers can be plain async functions.
 *
 * Worker-lifetime rule: handlers keep no module state that matters. The
 * source of truth is chrome.storage.session, so a worker kill between an
 * event click and the panel opening loses nothing.
 */

import * as auth from './auth.js';
import { getCalendarEvent, ApiError } from './googleApi.js';
import { runBriefing, resumeStaleBriefing } from './orchestrator.js';
import { MSG, STORAGE_KEYS } from '../shared/messages.js';
import { validateEventId, validateCalendarId } from '../shared/eventId.js';
import { debugLog } from '../shared/debug.js';
import { eventFromCalendarUrl } from './eventUrl.js';
import { ensureActiveTab } from './injector.js';

// ---------------------------------------------------------------------------
// Event-context state machine (written to storage.session, watched by panel)
// ---------------------------------------------------------------------------

async function setEventContext(context) {
  await chrome.storage.session.set({
    [STORAGE_KEYS.EVENT_CONTEXT]: { ...context, updatedAt: Date.now() },
  });
  return context;
}

/** Keep only what the panel (and later the LLM prompt) needs. */
function pickEventFields(event) {
  return {
    id: event.id,
    summary: event.summary ?? '(no title)',
    description: event.description ?? '',
    location: event.location ?? '',
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer ?? null,
    attendees: (event.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: a.displayName ?? '',
      responseStatus: a.responseStatus ?? '',
      organizer: Boolean(a.organizer),
      self: Boolean(a.self),
    })),
    hangoutLink: event.hangoutLink ?? '',
    // Non-Meet conferencing (Zoom/Teams add-ons) lands in conferenceData
    // entry points; the panel's Join-button allowlist validates the host.
    conferenceLink:
      event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? '',
    htmlLink: event.htmlLink ?? '',
  };
}

/**
 * Resolve the stored selected-event pointer into a full context via the
 * Calendar API. Auth is SILENT here unless the caller (AUTH_ENSURE) already
 * ran the interactive flow — background chains must never pop consent UI.
 */
async function refreshEventContext() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.SELECTED_EVENT);
  const selected = stored[STORAGE_KEYS.SELECTED_EVENT];
  if (!selected) return null;

  // Re-validate at the network boundary. The content script already
  // validated, but this is the last gate before a value becomes a URL, and
  // storage.session contents can outlive the code that wrote them (extension
  // update mid-session). Anything untrustworthy degrades to 'primary'.
  const calendarId = validateCalendarId(selected.calendarId) ?? 'primary';

  await setEventContext({ status: 'loading', hintTitle: selected.hintTitle ?? '' });
  try {
    debugLog('events.get', { eventId: selected.eventId, calendarId });
    const event = await getCalendarEvent(calendarId, selected.eventId);
    return setEventContext({ status: 'ready', event: pickEventFields(event) });
  } catch (err) {
    if (err instanceof auth.AuthError) {
      // consent_required / not_signed_in / missing_scopes all resolve the
      // same way from the panel: a user-gesture "Connect Google" button.
      return setEventContext({
        status: 'needs-auth',
        hintTitle: selected.hintTitle ?? '',
        authCode: err.code,
        missingScopes: err.missingScopes,
      });
    }

    // A 404 against 'primary' is the expected outcome for events that live on
    // a calendar the user only SUBSCRIBES to — holidays, birthdays, sports
    // schedules. Deliberately not solved with a calendarList lookup: those
    // events have no attendees and no email history, so there is nothing to
    // brief. Name the situation instead of leaking a bare API error.
    if (err instanceof ApiError && err.status === 404 && calendarId === 'primary') {
      return setEventContext({
        status: 'error',
        hintTitle: selected.hintTitle ?? '',
        message:
          "This event is on a subscribed calendar (holidays, birthdays, or similar) and can't be briefed.",
        detail: err.message,
      });
    }

    return setEventContext({
      status: 'error',
      hintTitle: selected.hintTitle ?? '',
      message: err instanceof ApiError ? err.message : `Unexpected: ${err?.message ?? err}`,
    });
  }
}

/**
 * Record a selection and resolve it. Shared by the click path and the URL
 * backstop so both go through identical validation and briefing-invalidation.
 */
async function applySelection({ eventId, calendarId, hintTitle, source }) {
  const prev = await chrome.storage.session.get(STORAGE_KEYS.SELECTED_EVENT);
  const previous = prev[STORAGE_KEYS.SELECTED_EVENT];

  // Switching events invalidates any briefing (including its checkpoint) —
  // stale cards for a different meeting are worse than no card.
  if (previous?.eventId !== eventId) {
    await chrome.storage.session.remove(STORAGE_KEYS.BRIEFING);
  }

  await chrome.storage.session.set({
    [STORAGE_KEYS.SELECTED_EVENT]: {
      eventId,
      calendarId, // null => refreshEventContext() uses 'primary'
      hintTitle,
      source,
      selectedAt: Date.now(),
    },
  });
  return refreshEventContext();
}

/**
 * URL backstop (Deliverable 2). Called from tabs.onUpdated.
 *
 * PRECEDENCE: the content script wins. It knows which element the user
 * actually clicked, whereas a URL can lag, describe a different view, or
 * persist after the user has moved on. A URL-derived id is therefore ignored
 * when a click-derived selection for a DIFFERENT event arrived moments ago,
 * and the disagreement is logged under the debug flag rather than silently
 * resolved.
 */
const CLICK_PRECEDENCE_MS = 3000;

export async function selectEventFromUrl(url, tabId) {
  const found = eventFromCalendarUrl(url);
  if (!found) return null;

  const stored = await chrome.storage.session.get(STORAGE_KEYS.SELECTED_EVENT);
  const current = stored[STORAGE_KEYS.SELECTED_EVENT];

  if (current?.eventId === found.eventId) return null; // already selected; nothing to do

  if (
    current?.source === 'content' &&
    Date.now() - (current.selectedAt ?? 0) < CLICK_PRECEDENCE_MS
  ) {
    debugLog(
      'URL/click disagreement — keeping the clicked event.',
      { clicked: current.eventId, fromUrl: found.eventId, via: found.source, tabId },
    );
    return null;
  }

  debugLog('event id recovered from URL', found.source, found.eventId);
  return applySelection({
    eventId: found.eventId,
    calendarId: found.calendarId,
    hintTitle: '',
    source: found.source,
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const handlers = {
  /** content script -> here. Store pointer, then resolve it (silent auth). */
  [MSG.EVENT_SELECTED]: async (message, sender) => {
    // Only accept event pointers from our own content script on Calendar —
    // a compromised page can't forge sender.tab metadata.
    if (!sender.tab?.url?.startsWith('https://calendar.google.com/')) {
      throw new Error('EVENT_SELECTED rejected: unexpected sender');
    }
    const { eventId: rawEventId, calendarId: rawCalendarId, rawTrailer, hintTitle } =
      message.payload ?? {};

    // calendarId is now optional — null means "the DOM's calendar segment was
    // truncated or absent, address this against primary".
    const eventId = validateEventId(rawEventId);
    if (!eventId) throw new Error('EVENT_SELECTED rejected: event id failed validation');
    const calendarId = validateCalendarId(rawCalendarId);
    if (rawCalendarId && !calendarId) {
      debugLog('calendar segment rejected at router:', rawCalendarId);
    }
    if (rawTrailer && !calendarId) {
      debugLog('DOM supplied truncated calendar segment:', rawTrailer, '-> using primary');
    }

    // 'content' marks this as click-derived, which the URL backstop treats
    // as authoritative for a few seconds (see selectEventFromUrl).
    return applySelection({ eventId, calendarId, hintTitle, source: 'content' });
  },

  /**
   * panel -> here, on mount. Guarantees a live content script in the active
   * Calendar tab and reports whether one is listening, so the panel can tell
   * "ready and waiting for a click" apart from "not listening" — states that
   * were previously indistinguishable to the user.
   */
  [MSG.ENSURE_CONTENT]: async () => ensureActiveTab(),

  /** panel (on mount) -> here. Return cached context; resolve if stale. */
  [MSG.GET_SELECTED_EVENT]: async () => {
    const stored = await chrome.storage.session.get([
      STORAGE_KEYS.EVENT_CONTEXT,
      STORAGE_KEYS.SELECTED_EVENT,
    ]);
    const context = stored[STORAGE_KEYS.EVENT_CONTEXT];
    if (context) return context;
    // Pointer exists but was never resolved (e.g. worker died mid-fetch).
    if (stored[STORAGE_KEYS.SELECTED_EVENT]) return refreshEventContext();
    return null;
  },

  /**
   * panel ("Connect Google" click) -> here. The click IS the user gesture
   * justifying the consent window. On success, immediately re-resolve any
   * pending event so the panel flips needs-auth -> ready in one action.
   */
  [MSG.AUTH_ENSURE]: async () => {
    const { grantedScopes } = await auth.getToken({ interactive: true });
    const context = await refreshEventContext();
    return { grantedScopes, context };
  },

  /**
   * panel ("Generate briefing" click) -> here. Runs (or resumes) the full
   * pipeline; progress streams to the panel via the storage.session watch,
   * so this response is just the terminal state.
   */
  [MSG.RUN_BRIEFING]: async (message) =>
    runBriefing({ auto: Boolean(message.payload?.auto) }),

  /** panel (on mount) -> here. Also the resume trigger for dead runs. */
  [MSG.GET_BRIEFING]: async () => {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.BRIEFING);
    const briefing = stored[STORAGE_KEYS.BRIEFING] ?? null;
    // Fire-and-forget: the panel gets the current state NOW; if that state is
    // a dead 'running' checkpoint, the resume re-drives it and the panel sees
    // fresh progress via storage.onChanged.
    resumeStaleBriefing(briefing).catch((err) =>
      console.warn('[mpf] stale-briefing resume failed:', err),
    );
    return briefing;
  },
};

// ---------------------------------------------------------------------------
// Listener (registered synchronously at module top level — worker-restart safe)
// ---------------------------------------------------------------------------

function serializeError(err) {
  return {
    message: err?.message ?? String(err),
    name: err?.name ?? 'Error',
    code: err?.code,
    status: err?.status,
    missingScopes: err?.missingScopes,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false; // not ours; let other listeners respond

  handler(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.warn('[mpf] handler failed:', message.type, err);
      sendResponse({ ok: false, error: serializeError(err) });
    });
  return true; // keep sendResponse alive across the await
});
