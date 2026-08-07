/**
 * data-eventid decode + validation. Shared by the content script (which
 * reads the attribute) and the background router (which re-validates before
 * anything reaches the network) — one implementation, enforced twice.
 *
 * ── What data-eventid actually contains ───────────────────────────────────
 * base64url of "<eventId> <calendarSegment>". Both parts were assumed usable
 * through Phase 3. They are not:
 *
 *   raw (59 chars) -> "73krm2k9574js0dnnimu1dkmpb " someuser@m
 *
 * That decode is complete — 44 bytes is exactly 59 base64 characters, and
 * padded vs unpadded atob produce byte-identical output. Google itself
 * truncates the calendar identifier in the DOM ("@m", not "@gmail.com").
 * Sending it to events.get produced a legitimate 404 against a calendar that
 * does not exist, which read as "the extension is broken" for every event.
 *
 * ── The rule now ──────────────────────────────────────────────────────────
 * The EVENT ID is the only part we trust from the DOM. The calendar segment
 * is used ONLY if it independently validates as a complete calendar
 * identifier; otherwise it is discarded and the caller uses 'primary', which
 * resolves any event on the user's own calendars — the entire target use
 * case. A plausible-but-wrong identifier must never reach the network layer:
 * that is precisely what turned a decode bug into an opaque 404.
 */

/**
 * Calendar event IDs are base32hex (a-v, 0-9) for API-created events, wider
 * for imported ones, and recurring INSTANCES append "_YYYYMMDDTHHMMSSZ" —
 * uppercase T/Z included, which is why this pattern is case-sensitive-
 * permissive. The suffix is part of the ID and is passed through intact:
 * events.get resolves an instance ID directly, and stripping it would
 * silently return the recurring series' master event instead of the
 * occurrence the user clicked.
 */
const EVENT_ID_RE = /^[A-Za-z0-9_.-]{5,1024}$/;

/**
 * A usable calendar identifier is a COMPLETE email-shaped address: a local
 * part, an "@", and a dotted domain. This is the test the DOM's truncated
 * "user@m" fails. Group/holiday calendars
 * ("en.italian#holiday@group.v.calendar.google.com") pass it — "#" is legal
 * in the local part here — so a full one may be used when Google happens to
 * supply it.
 */
const CALENDAR_ID_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** @returns {string|null} the identifier if usable, else null (use 'primary') */
export function validateCalendarId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 320) return null;
  return CALENDAR_ID_RE.test(value) ? value : null;
}

export function validateEventId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return EVENT_ID_RE.test(value) ? value : null;
}

/** True for a recurring-instance ID ("<masterId>_20260721T150000Z"). */
export function isRecurringInstanceId(eventId) {
  return /_\d{8}T\d{6}Z$/.test(eventId ?? '');
}

/**
 * Decode one chip's data-eventid.
 *
 * @returns {{
 *   eventId: string,
 *   calendarId: string|null,   // null => caller uses 'primary'
 *   rawTrailer: string,        // what Google actually supplied, for diagnostics
 *   trailerRejected: boolean,  // trailer existed but failed validation
 *   decoded: string
 * } | { error: string, raw: string }}
 *   The error shape is for diagnostics only; callers treat it as "not an
 *   event chip" and do nothing (tasks, reminders, and birthday chips also
 *   land here).
 */
export function decodeEventChip(raw) {
  if (!raw) return { error: 'empty attribute', raw: '' };

  let decoded;
  try {
    // base64url -> base64, then re-pad (atob rejects length % 4 === 1).
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return { error: 'not base64', raw };
  }

  // Space-separated; a chip with no separator is not an event pointer.
  const spaceAt = decoded.indexOf(' ');
  if (spaceAt <= 0) return { error: 'no separator', raw, decoded };
  const idPart = decoded.slice(0, spaceAt);
  const rawTrailer = decoded.slice(spaceAt + 1);

  /**
   * Chip-type filter. Calendar also renders tasks, reminders and birthdays
   * with data-eventid; their trailer is a type marker ("tasks") rather than
   * a calendar address. Requiring an "@" keeps them out WITHOUT trusting the
   * trailer's content — "someuser@m" is calendar-SHAPED (so this is an
   * event) yet still fails validateCalendarId (so it isn't usable). Those are
   * two different questions and this is the cheap answer to the first.
   */
  if (!rawTrailer.includes('@')) {
    return { error: 'not an event chip (no calendar-shaped trailer)', raw, decoded };
  }

  const eventId = validateEventId(idPart);
  if (!eventId) return { error: 'event id failed validation', raw, decoded };

  const calendarId = validateCalendarId(rawTrailer);
  return {
    eventId,
    calendarId,
    rawTrailer,
    trailerRejected: Boolean(rawTrailer) && calendarId === null,
    decoded,
  };
}
