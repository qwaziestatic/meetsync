/**
 * Background-side event extraction from the Calendar URL — a REDUNDANCY
 * layer behind the content script, not a replacement.
 *
 * It reuses shared/eventId.js wholesale: the identifiers Calendar puts in
 * URLs use the same base64url("<eventId> <calendarSegment>") encoding as the
 * `data-eventid` DOM attribute, so the same decoder and the same validation
 * apply — including the finding that the calendar segment is usually
 * truncated and must be discarded in favour of `primary`. There is
 * deliberately no second parser.
 *
 * ── Honest status of the URL patterns ────────────────────────────────────
 * I could NOT verify these empirically: Calendar is an authenticated SPA and
 * I have no browser session. The patterns below are the ones I can justify;
 * they have NOT been confirmed against your account, and the module is built
 * so that being wrong is harmless rather than damaging:
 *
 *   • Unrecognised URL  -> returns null. No guessing, no false positives.
 *   • Recognised but the payload fails decode/validation -> returns null.
 *   • The content script always wins a disagreement (see router).
 *
 * Patterns handled:
 *   ?eid=<base64url>            — the canonical event link (invitation
 *                                 links, "open in Calendar", search results).
 *                                 Highest confidence: `eid` is the long-
 *                                 standing public parameter and carries the
 *                                 same encoding as data-eventid.
 *   /r/eventedit/<base64url>    — the edit route.
 *   /r/event/<base64url>        — the event detail route.
 *
 * Expected NOT to carry an identifier (and correctly yielding null):
 *   /r/day/2026/8/7, /r/week/…, /r/month/…, /r/customday/…  — grid views.
 *   Opening an event popup in a grid view typically does not change the URL
 *   at all, which is precisely why the content script remains primary: the
 *   most common way to open an event is invisible to this path.
 *
 * Run `scripts/capture-calendar-urls.js` to record what your Calendar
 * actually produces across views and correct this list from real data.
 */

import { decodeEventChip } from '../shared/eventId.js';

const EVENT_PATH_SEGMENTS = ['eventedit', 'event'];

/**
 * @returns {{eventId: string, calendarId: string|null, source: string}|null}
 */
export function eventFromCalendarUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://calendar.google.com/')) {
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // 1. ?eid= — highest confidence.
  const eid = url.searchParams.get('eid');
  const fromEid = eid && decodeEventChip(eid);
  if (fromEid && !fromEid.error) {
    return { eventId: fromEid.eventId, calendarId: fromEid.calendarId, source: 'url:eid' };
  }

  // 2. /r/<route>/<payload> for the event routes only.
  const segments = url.pathname.split('/').filter(Boolean);
  const routeIndex = segments.findIndex((s) => EVENT_PATH_SEGMENTS.includes(s));
  if (routeIndex >= 0) {
    const payload = segments[routeIndex + 1];
    const decoded = payload && decodeEventChip(payload);
    if (decoded && !decoded.error) {
      return {
        eventId: decoded.eventId,
        calendarId: decoded.calendarId,
        source: `url:${segments[routeIndex]}`,
      };
    }
  }

  return null;
}
