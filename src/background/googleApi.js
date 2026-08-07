/**
 * Thin typed-ish wrappers over the Google REST endpoints. Every call funnels
 * through auth.fetchWithAuth (Authorization header + one-shot 401 recovery).
 */

import { fetchWithAuth } from './auth.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

/** Non-2xx API responses, distinct from AuthError so the router can branch. */
export class ApiError extends Error {
  /** @param {object} [details] request identifiers echoed into the message */
  constructor(message, status, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    Object.assign(this, details);
  }
}

async function getJson(url) {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      // Non-JSON error body — status alone is enough.
    }
    throw new ApiError(`Google API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json();
}

/**
 * Fetch one event.
 *
 * calendarId defaults to 'primary' — the DOM's calendar segment is usually
 * truncated and gets discarded upstream (see shared/eventId.js). 'primary'
 * resolves any event on the user's own calendars, including ones they were
 * merely invited to, because that is their own copy. Recurring-instance IDs
 * (`..._20260721T150000Z`) resolve directly and are passed through intact.
 *
 * 4xx failures carry the identifiers actually used INTO the message. The
 * previous "Google API 404: Not Found" made a decode bug, a permissions
 * problem and a genuinely missing event indistinguishable from the panel.
 * Neither identifier is a secret — both are sitting in the page DOM.
 */
export async function getCalendarEvent(calendarId, eventId) {
  const calendar = calendarId || 'primary';
  try {
    return await getJson(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      throw new ApiError(
        `${err.message} [event ${eventId} on calendar "${calendar}"]`,
        err.status,
        { calendarId: calendar, eventId },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Gmail (readonly)
// ---------------------------------------------------------------------------

/**
 * Google Calendar's own notification senders. Invitation, RSVP and
 * event-update mail is generated moments before a meeting, so without this
 * filter it is reliably the NEWEST thread with any attendee and crowds out
 * the actual correspondence a briefing exists to surface ("Dagim accepted
 * the meeting invitation for Test Meetos" is not a last communication — and
 * the RSVP dot on the same card already says it).
 *
 * Discriminator choice: the `Sender` HEADER, never subject text. Subjects
 * ("Invitation:", "Accepted:", "Updated invitation:") are localized per the
 * recipient's Calendar language, so a subject filter silently stops working
 * for any non-English user.
 *
 * ── Real RSVP headers, captured from a live message 2026-08-06 ────────────
 *   Subject:        Accepted: Test Meetos @ Thu Aug 6, 2026 (…)
 *   From:           Dagim Tsegaye <attendee@example.com.com>   <- the ATTENDEE
 *   Sender:         Google Calendar <calendar-notification@google.com>
 *   Reply-To:       Dagim Tsegaye <attendee@example.com>   <- the ATTENDEE
 *   Return-Path:    <attendee@example.com>                 <- the ATTENDEE
 *   Auto-Submitted: auto-generated
 *   Content-Type:   multipart/mixed; boundary="…"
 *
 * Two consequences that drive everything below:
 *  1. Calendar sends RSVP mail ON BEHALF OF the responder. From, Reply-To and
 *     Return-Path are all the attendee; `Sender` is the ONLY header carrying
 *     a Google address. Any From-based test — including Gmail's `from:`
 *     search operator — cannot match this mail, by construction.
 *  2. The iCalendar payload is a nested MIME sub-part; the top-level
 *     Content-Type is multipart/mixed. A top-level text/calendar test fails
 *     on exactly the messages it was written for.
 *
 * `noreply-calendar-sync@google.com` is additionally documented by Google
 * (Workspace admin guide to filtering Calendar notifications).
 */
const CALENDAR_SENDERS = [
  'calendar-notification@google.com',
  'noreply-calendar-sync@google.com',
];

/** Depth-first scan for an iCalendar MIME part, when parts are present. */
function hasCalendarPart(part) {
  if (!part) return false;
  if ((part.mimeType ?? '').toLowerCase().startsWith('text/calendar')) return true;
  return (part.parts ?? []).some(hasCalendarPart);
}

/**
 * Per-message test for machine-generated calendar mail.
 *
 * Rule 1 — `Sender` matches a known Calendar address. This is THE
 * discriminator, confirmed against the live headers above. It is checked
 * first and needs no corroboration: nothing but Calendar sends as
 * calendar-notification@google.com. From is also scanned, purely because it
 * costs nothing and covers notification variants that don't send on behalf
 * of a person.
 *
 * Rule 2 — a fallback for Calendar senders not in our list: RFC 3834
 * auto-generated AND positive iCalendar evidence. The AND is deliberate and
 * must stay: a great deal of legitimate correspondence is
 * `Auto-Submitted: auto-generated` — CI notifications, ticketing systems,
 * code-review mail — and that IS useful meeting context. Auto-Submitted
 * alone would filter it out, which would be a worse bug than the one this
 * function exists to fix.
 *
 * The iCalendar evidence no longer requires a TOP-LEVEL text/calendar
 * Content-Type (see consequence 2 above). It accepts a nested text/calendar
 * part when the payload tree is available. Gmail's format=metadata is
 * documented to return headers rather than the part tree, so hasCalendarPart
 * is opportunistic: it strengthens Rule 2 wherever parts happen to be
 * present and is inert otherwise. No extra request is made to obtain them —
 * fetching bodies to classify mail we are trying NOT to read would trade a
 * cosmetic bug for a privacy regression.
 */
function isCalendarGenerated(headers, message) {
  const originators = `${headers.sender ?? ''} ${headers.from ?? ''}`.toLowerCase();
  if (CALENDAR_SENDERS.some((addr) => originators.includes(addr))) return true;

  const autoSubmitted = (headers['auto-submitted'] ?? '').toLowerCase();
  if (!autoSubmitted.startsWith('auto-')) return false;

  const contentType = (headers['content-type'] ?? '').toLowerCase();
  return (
    contentType.includes('text/calendar') ||
    contentType.includes('method=') ||
    hasCalendarPart(message?.payload)
  );
}

/**
 * Headers requested from threads.get — free within format=metadata.
 * `Sender` is load-bearing, not decorative: it is the only header on RSVP
 * mail that carries a Google address. Removing it silently disables the
 * calendar filter.
 */
const METADATA_HEADERS = ['Subject', 'From', 'Date', 'Sender', 'Auto-Submitted', 'Content-Type'];

/**
 * How many recent threads to consider per attendee before concluding there
 * is no real correspondence. Bounded because each costs a threads.get: 3
 * covers a burst of invite + RSVP + update mail before a meeting, which is
 * the realistic worst case, without turning one briefing into a mailbox
 * crawl.
 */
const MAX_THREAD_CANDIDATES = 3;

function headerMap(message) {
  return Object.fromEntries(
    (message?.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );
}

/**
 * Most recent GENUINE email thread exchanged with one attendee, compacted to
 * what the briefing needs. Two round-trips:
 *   1. threads.list  q="(from:X OR to:X)" maxResults=1  — newest-first
 *   2. threads.get   format=metadata — headers + per-message snippets only.
 *
 * format=metadata is deliberate: we get Subject/From/Date + Gmail's own
 * ~200-char snippet WITHOUT downloading full MIME bodies. Snippets are
 * enough signal for a "last communication" summary, keep the LLM payload
 * small, and minimize how much mail content transits the pipeline at all.
 *
 * ── Where the calendar filtering actually happens ────────────────────────
 * THE RESULT LEVEL CARRIES THIS. Gmail's search grammar cannot express the
 * discriminator: it has no operator for the `Sender` header, and `from:`
 * matches the From header, which on RSVP mail is the attendee themselves.
 * `-from:calendar-notification@google.com` is therefore retained only for
 * notification variants that really do send From that address (event
 * updates, Interop sync) — it provably cannot match an RSVP, and pretending
 * otherwise is how the previous version looked protective without being so.
 * `-filename:invite.ics` is opportunistic and UNVERIFIED against real RSVP
 * mail; if it works it saves a fetch, and nothing depends on it.
 *
 * Because the query cannot be trusted to exclude notification threads, noise
 * must not be allowed to DISPLACE the real answer: an RSVP arriving minutes
 * before the meeting is the newest thread with that attendee, so asking for
 * one thread and filtering it to nothing would report "no recent email"
 * while a genuine conversation sat one row below. We therefore ask for a few
 * candidate threads and walk to the first that contains real correspondence.
 *
 * Quota: threads.list=10u plus threads.get=10u per candidate ACTUALLY
 * fetched. The common case is still one get (the newest thread is real);
 * only an attendee whose recent threads are all notifications costs the
 * extra calls, capped at MAX_THREAD_CANDIDATES.
 *
 * @returns {Promise<object|null>} null when this attendee has no genuine mail
 *   history. Null is the HONEST-EMPTY signal: the caller records no thread
 *   and no failure, so the card renders "No recent email with this attendee"
 *   rather than the degraded "Couldn't check email history" marker, which is
 *   reserved for a rejected query.
 */
export async function getLatestThreadWith(email) {
  const exclusions = [
    // Matches only notification mail that genuinely uses these addresses in
    // From. Cannot match RSVP mail — see the note above.
    ...CALENDAR_SENDERS.map((addr) => `-from:${addr}`),
    // Opportunistic: unverified against real RSVP mail. A genuine human
    // email attaching invite.ics would also be skipped, which is acceptable
    // because the next real thread is the better answer anyway.
    '-filename:invite.ics',
    // Legacy Hangouts artifacts pollute results on old accounts.
    '-in:chats',
  ].join(' ');

  const listParams = new URLSearchParams({
    q: `(from:${email} OR to:${email}) ${exclusions}`,
    maxResults: String(MAX_THREAD_CANDIDATES),
  });
  const list = await getJson(`${GMAIL_BASE}/threads?${listParams}`);
  const candidates = list.threads ?? [];
  if (candidates.length === 0) return null;

  const getParams = new URLSearchParams({ format: 'metadata' });
  for (const h of METADATA_HEADERS) getParams.append('metadataHeaders', h);

  // Newest thread first; within a thread, newest message first. Stop at the
  // first message that is real correspondence.
  for (const ref of candidates) {
    const thread = await getJson(`${GMAIL_BASE}/threads/${ref.id}?${getParams}`);
    const messages = thread.messages ?? [];

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const headers = headerMap(messages[i]);
      if (isCalendarGenerated(headers, messages[i])) continue;
      return {
        email,
        threadId: thread.id,
        subject: headers.subject ?? '(no subject)',
        from: headers.from ?? '',
        date: headers.date ?? '',
        // Must come from the CHOSEN message: threadRef.snippet describes the
        // thread's newest message, which may be the invite we just skipped.
        snippet: messages[i].snippet ?? '',
        messageCount: messages.length,
      };
    }
    // Whole thread was calendar noise — try the next-newest thread.
  }

  return null;
}

// ---------------------------------------------------------------------------
// Drive (metadata.readonly)
// ---------------------------------------------------------------------------

/** Escape a value for embedding in a Drive q single-quoted string literal. */
function driveEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Recently modified files matching the meeting title terms OR owned/edited by
 * attendees. `name contains` + owners/writers only — no fullText: content
 * search isn't reliable under the metadata-only scope, and title/ownership
 * matching is a far better precision/noise tradeoff for a briefing anyway.
 * Relevance filtering is the LLM's job downstream; this just gathers
 * candidates, newest first.
 */
export async function findRecentDocs({ titleTerms = [], attendeeEmails = [], pageSize = 10 }) {
  const clauses = [
    ...titleTerms.map((t) => `name contains '${driveEscape(t)}'`),
    ...attendeeEmails.flatMap((e) => [
      `'${driveEscape(e)}' in owners`,
      `'${driveEscape(e)}' in writers`,
    ]),
  ];
  if (clauses.length === 0) return [];

  const params = new URLSearchParams({
    q: `trashed = false and (${clauses.join(' or ')})`,
    orderBy: 'modifiedTime desc',
    pageSize: String(pageSize),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))',
  });
  const result = await getJson(`${DRIVE_BASE}/files?${params}`);
  return result.files ?? [];
}

// ---------------------------------------------------------------------------
// Drive document TEXT (opt-in; requires drive.readonly — see auth.activeScopes)
// ---------------------------------------------------------------------------

/**
 * How each file type yields text. Verified 2026-08-07 against Google's
 * export-formats reference — and it is NOT uniform, which is the trap here:
 *
 *   Google Docs        -> files.export, text/plain   ✓
 *   Google Slides      -> files.export, text/plain   ✓
 *   Google Sheets      -> files.export, text/csv     (NO text/plain export
 *                         exists for Sheets; assuming otherwise 400s. CSV is
 *                         first-sheet-only, which is stated to the model.)
 *   text/* , JSON, MD  -> files.get?alt=media (already text on the wire)
 *
 * Everything else — PDFs, images, video, archives, Office binaries — is
 * deliberately absent and stays metadata-only. PDFs are the notable
 * omission: extracting their text means bundling a PDF parser into the MV3
 * service worker, and that worker cold-starts on every event and re-parses
 * its whole bundle each time. pdfjs-dist is ~34 MB unpacked / ~1 MB of
 * minified runtime against a 20 KB worker — a 50× weight increase paid on
 * every cold start, for a minority of files. Deferred deliberately; the card
 * says "content not read" rather than silently omitting the file.
 */
const EXPORT_TEXT_TYPES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const DIRECT_TEXT_PATTERN = /^(text\/|application\/(json|xml|x-yaml|yaml))/i;

/**
 * @returns {'export'|'download'|null} how to get text, or null if this type
 *   has no reliable/meaningful text extraction (image, video, PDF, archive).
 */
export function textStrategyFor(mimeType) {
  if (!mimeType) return null;
  if (EXPORT_TEXT_TYPES[mimeType]) return 'export';
  if (DIRECT_TEXT_PATTERN.test(mimeType)) return 'download';
  return null;
}

async function getText(url, maxChars) {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    throw new ApiError(`Drive text fetch ${res.status}`, res.status);
  }
  const text = await res.text();
  // Cap AFTER download: Drive has no server-side range for exports, so this
  // bounds prompt size and storage, not bandwidth.
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

/**
 * Fetch one document's text.
 *
 * @param {{id: string, mimeType: string, name: string}} file
 * @param {number} maxChars hard per-document cap
 * @returns {Promise<{text: string, truncated: boolean, format: string}|null>}
 *   null when the type has no text strategy — the caller records that as
 *   "content not read" rather than dropping the document.
 */
export async function getDocumentText(file, maxChars) {
  const strategy = textStrategyFor(file.mimeType);
  if (!strategy) return null;

  if (strategy === 'export') {
    const exportMime = EXPORT_TEXT_TYPES[file.mimeType];
    const params = new URLSearchParams({ mimeType: exportMime });
    const { text, truncated } = await getText(
      `${DRIVE_BASE}/files/${encodeURIComponent(file.id)}/export?${params}`,
      maxChars,
    );
    return { text, truncated, format: exportMime };
  }

  const { text, truncated } = await getText(
    `${DRIVE_BASE}/files/${encodeURIComponent(file.id)}?alt=media`,
    maxChars,
  );
  return { text, truncated, format: file.mimeType };
}
