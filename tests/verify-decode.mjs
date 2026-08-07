/**
 * Verification harness for the decode-and-validate fix.
 * Imports the SHIPPING module (src/shared/eventId.js) â€” no reimplementation.
 * Simulates the router's calendar selection + 404 mapping around it.
 */
import {
  decodeEventChip,
  validateCalendarId,
  validateEventId,
  isRecurringInstanceId,
} from '../src/shared/eventId.js';

// atob exists in Node 20 globals; the module targets browsers where it's native.
const b64url = (s) => Buffer.from(s, 'binary').toString('base64url');

// --- router logic mirrored (see refreshEventContext / getCalendarEvent) -----
function simulateRouter(parsed, apiResponder) {
  const calendarId = validateCalendarId(parsed.calendarId) ?? 'primary';
  const res = apiResponder(calendarId, parsed.eventId);
  if (res.status === 200) return { state: 'ready', calendarId, event: res.body };

  // googleApi.getCalendarEvent 4xx enrichment
  const enriched = `Google API ${res.status}${res.detail ? `: ${res.detail}` : ''} [event ${parsed.eventId} on calendar "${calendarId}"]`;
  if (res.status === 404 && calendarId === 'primary') {
    return {
      state: 'error',
      calendarId,
      message:
        "This event is on a subscribed calendar (holidays, birthdays, or similar) and can't be briefed.",
      detail: enriched,
    };
  }
  return { state: 'error', calendarId, message: enriched };
}

function report(name, rawAttr, apiResponder) {
  console.log('\n=== ' + name + ' ===');
  console.log('raw data-eventid      :', rawAttr, `(${rawAttr.length} chars)`);
  const parsed = decodeEventChip(rawAttr);
  if (parsed.error) {
    console.log('DECODE REJECTED       :', parsed.error);
    console.log('decoded               :', JSON.stringify(parsed.decoded));
    return;
  }
  console.log('decoded               :', JSON.stringify(parsed.decoded));
  console.log('eventId (parsed)      :', parsed.eventId);
  console.log('recurring instance?   :', isRecurringInstanceId(parsed.eventId));
  console.log('trailer from DOM      :', JSON.stringify(parsed.rawTrailer));
  console.log('trailer rejected?     :', parsed.trailerRejected);
  console.log('calendarId sent to API:', validateCalendarId(parsed.calendarId) ?? 'primary');
  const out = simulateRouter(parsed, apiResponder);
  console.log('panel state           :', out.state);
  console.log('panel message         :', out.message ?? '(card renders)');
  if (out.detail) console.log('panel detail          :', out.detail);
}

// --- (a) user's real fixture: primary-calendar event, truncated trailer -----
const A_RAW = b64url('73krm2k9574js0dnnimu1dkmpb dagimtsegaye014@m');
console.log('fixture (a) length check â€” expected 59:', A_RAW.length);
report('(a) normal event on primary calendar', A_RAW, (cal, id) =>
  cal === 'primary'
    ? { status: 200, body: { id, summary: 'Design sync', attendees: ['a@x.com', 'b@y.com'] } }
    : { status: 404, detail: 'Not Found' },
);

// --- (b) subscribed holiday calendar ---------------------------------------
// Google truncates this trailer the same way it truncates the primary one.
const B_RAW = b64url('20260101_1a2b3c4d5e6f7g8h en.italian#holiday@g');
report('(b) all-day event, Holidays in Italy (subscribed)', B_RAW, () => ({
  status: 404,
  detail: 'Not Found',
}));

// --- (b2) same event IF Google supplied the full group id -------------------
const B2_RAW = b64url('20260101_1a2b3c4d5e6f7g8h en.italian#holiday@group.v.calendar.google.com');
report('(b2) same, hypothetical untruncated trailer', B2_RAW, (cal) =>
  cal === 'primary' ? { status: 404, detail: 'Not Found' } : { status: 200, body: { summary: 'Capodanno' } },
);

// --- (c) recurring instance -------------------------------------------------
const C_RAW = b64url('73krm2k9574js0dnnimu1dkmpb_20260721T150000Z dagimtsegaye014@m');
report('(c) recurring event instance', C_RAW, (cal, id) =>
  cal === 'primary' && id.endsWith('_20260721T150000Z')
    ? { status: 200, body: { id, summary: 'Weekly 1:1 (this occurrence)' } }
    : { status: 404, detail: 'Not Found' },
);

// --- validator unit checks --------------------------------------------------
console.log('\n=== validator checks ===');
const calCases = [
  ['dagimtsegaye014@m', null],
  ['dagimtsegaye014@gmail.com', 'dagimtsegaye014@gmail.com'],
  ['en.italian#holiday@group.v.calendar.google.com', 'en.italian#holiday@group.v.calendar.google.com'],
  ['primary', null],
  ['user@g', null],
  ['user@localhost', null],
  ['', null],
  [null, null],
];
for (const [input, expected] of calCases) {
  const got = validateCalendarId(input);
  console.log(`${got === expected ? 'PASS' : 'FAIL'}  validateCalendarId(${JSON.stringify(input)}) -> ${JSON.stringify(got)}`);
}

const idCases = [
  ['73krm2k9574js0dnnimu1dkmpb', true],
  ['73krm2k9574js0dnnimu1dkmpb_20260721T150000Z', true],
  ['abc', false],
  ['bad id with spaces', false],
  ['../../../etc/passwd', false],
  ['evt<script>', false],
];
for (const [input, ok] of idCases) {
  const got = validateEventId(input);
  console.log(`${Boolean(got) === ok ? 'PASS' : 'FAIL'}  validateEventId(${JSON.stringify(input)}) -> ${JSON.stringify(got)}`);
}

// Non-event chips (tasks/reminders) must be ignored, not sent.
console.log('\n=== non-event chips ===');
for (const raw of [b64url('task_12345 tasks'), b64url('noseparator'), 'not-base64!!!']) {
  const p = decodeEventChip(raw);
  console.log(JSON.stringify(raw).slice(0, 40), '->', p.error ? `ignored (${p.error})` : `PARSED eventId=${p.eventId} cal=${p.calendarId ?? 'primary'}`);
}

