/**
 * Verifies the calendar-noise filter in googleApi.getLatestThreadWith and,
 * critically, that a fully-filtered attendee lands on the HONEST-EMPTY state
 * ("No recent email") rather than the DEGRADED state ("Couldn't check").
 * Imports shipping modules; stubs only fetch + chrome.
 */
const SRC = '../src';

let routes = [];
globalThis.chrome = { storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } } };
let lastGetUrl = '';
globalThis.fetch = async (url) => {
  if (String(url).includes('/threads/')) lastGetUrl = decodeURIComponent(String(url));
  const route = routes.find((r) => r.match(String(url)));
  if (!route) throw new Error(`unstubbed URL: ${url}`);
  if (route.reject) throw new Error('network down');
  return { ok: true, status: 200, json: async () => route.body };
};
// auth.fetchWithAuth calls getToken -> chrome.identity
globalThis.chrome.identity = { getAuthToken: async () => ({ token: 't', grantedScopes: [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
] }) };

const { getLatestThreadWith } = await import(`${SRC}/background/googleApi.js`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? ` â€” ${extra}` : ''}`);
  cond ? pass++ : fail++;
};

const hdr = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const listUrl = (u) => u.includes('/threads?');
const getUrl = (u) => u.includes('/threads/');

let capturedQuery = '';
let capturedMax = '';
const withList = (threads, thread) => {
  routes = [
    { match: (u) => { if (listUrl(u)) { const p = new URL(u).searchParams; capturedQuery = decodeURIComponent(p.get('q')); capturedMax = p.get('maxResults'); return true; } return false; }, body: { threads } },
    { match: getUrl, body: thread },
  ];
};
/** Per-thread bodies keyed by id, for multi-candidate walks. */
const withThreads = (threadsById) => {
  routes = [
    { match: (u) => { if (listUrl(u)) { const p = new URL(u).searchParams; capturedQuery = decodeURIComponent(p.get('q')); capturedMax = p.get('maxResults'); return true; } return false; },
      body: { threads: Object.keys(threadsById).map((id) => ({ id })) } },
    { match: (u) => { if (!getUrl(u)) return false; const id = String(u).split('/threads/')[1].split('?')[0]; routes[1].body = threadsById[id]; return true; }, body: null },
  ];
};

// --- 1. query-level exclusions ---------------------------------------------
console.log('=== query construction ===');
withList([], null);
await getLatestThreadWith('ada@example.com');
check('excludes calendar-notification sender', capturedQuery.includes('-from:calendar-notification@google.com'), capturedQuery);
check('excludes noreply-calendar-sync sender', capturedQuery.includes('-from:noreply-calendar-sync@google.com'));
check('excludes invite.ics attachments', capturedQuery.includes('-filename:invite.ics'));
check('still scopes to the attendee', capturedQuery.includes('(from:ada@example.com OR to:ada@example.com)'));
check('keeps -in:chats', capturedQuery.includes('-in:chats'));

// --- 1b. REAL captured RSVP headers ----------------------------------------
console.log('\n=== real RSVP message (verbatim live headers) ===');
const realRsvp = {
  snippet: 'Dagim accepted the meeting invitation for Test Meetos.',
  payload: {
    mimeType: 'multipart/mixed',
    headers: hdr({
      Subject: 'Accepted: Test Meetos @ Thu Aug 6, 2026 (dagimtsegaye014@gmail.com)',
      From: 'Dagim Tsegaye <dagimtsegaye151@gmail.com>',
      Sender: 'Google Calendar <calendar-notification@google.com>',
      'Reply-To': 'Dagim Tsegaye <dagimtsegaye151@gmail.com>',
      'Return-Path': '<dagimtsegaye151@gmail.com>',
      'Auto-Submitted': 'auto-generated',
      'Content-Type': 'multipart/mixed; boundary="0000000000009addb7065852df08"',
    }),
  },
};
withList([{ id: 'r1' }], { id: 'r1', messages: [realRsvp] });
check('real RSVP (From=attendee, Sender=Google, multipart/mixed) is filtered',
  (await getLatestThreadWith('dagimtsegaye151@gmail.com')) === null);
check('requests the Sender header from threads.get (load-bearing)',
  lastGetUrl.includes('metadataHeaders=Sender'), lastGetUrl);

// Nested iCalendar part, unknown sender â€” Rule 2 without top-level text/calendar.
const nestedIcs = { snippet: 'invite', payload: { mimeType: 'multipart/mixed', headers: hdr({
  Subject: 'Invitation', From: 'someone@corp.com', 'Auto-Submitted': 'auto-generated',
  'Content-Type': 'multipart/mixed; boundary="x"' }),
  parts: [{ mimeType: 'text/plain' }, { mimeType: 'text/calendar; charset=UTF-8; method=REPLY' }] } };
withList([{ id: 'r2' }], { id: 'r2', messages: [nestedIcs] });
check('nested text/calendar part + auto-generated, unknown sender -> filtered',
  (await getLatestThreadWith('a@b.com')) === null);

// --- 1c. noise must not DISPLACE a genuine older thread ---------------------
console.log('\n=== displacement (the real query-level gap) ===');
const realThread = { id: 'old', messages: [{ snippet: 'Sending the roadmap draft',
  payload: { headers: hdr({ Subject: 'Roadmap draft', From: 'Ada <ada@example.com>', Date: 'Mon, 3 Aug 2026' }) } }] };
withThreads({ rsvp: { id: 'rsvp', messages: [realRsvp] }, old: realThread });
const notDisplaced = await getLatestThreadWith('ada@example.com');
check('newest thread is RSVP -> falls through to the genuine older thread',
  notDisplaced?.subject === 'Roadmap draft', JSON.stringify(notDisplaced));
check('asks for multiple candidate threads', capturedMax === '3', `maxResults=${capturedMax}`);

withThreads({ n1: { id: 'n1', messages: [realRsvp] }, n2: { id: 'n2', messages: [realRsvp] }, n3: { id: 'n3', messages: [realRsvp] } });
check('all candidates are noise -> null (honest empty, not a wrong answer)',
  (await getLatestThreadWith('a@b.com')) === null);

// --- 2. result-level walk ---------------------------------------------------
console.log('\n=== result filtering ===');
const realMsg = { snippet: 'Sending the roadmap draft', payload: { headers: hdr({ Subject: 'Roadmap draft', From: 'Ada <ada@example.com>', Date: 'Mon, 3 Aug 2026 09:12:00 +0000' }) } };
const rsvpMsg = { snippet: 'Dagim accepted the meeting invitation for Test Meetos.', payload: { headers: hdr({ Subject: 'Accepted: Test Meetos', From: 'Dagim <calendar-notification@google.com>', Date: 'Wed, 5 Aug 2026 10:00:00 +0000' }) } };
const icsMsg = { snippet: 'Invitation body', payload: { headers: hdr({ Subject: 'Invitation: Sync', From: 'Someone <someone@corp.com>', 'Auto-Submitted': 'auto-generated', 'Content-Type': 'text/calendar; method=REQUEST; charset=UTF-8' }) } };
const ticketMsg = { snippet: 'Build #42 failed', payload: { headers: hdr({ Subject: '[CI] build failed', From: 'ci@corp.com', 'Auto-Submitted': 'auto-generated', 'Content-Type': 'text/plain' }) } };

withList([{ id: 't1', snippet: 'thread-level snippet from the RSVP' }], { id: 't1', messages: [realMsg, rsvpMsg] });
let r = await getLatestThreadWith('ada@example.com');
check('skips trailing RSVP, returns the real message', r?.subject === 'Roadmap draft', JSON.stringify(r));
check('snippet comes from the chosen message, not the thread', r?.snippet === 'Sending the roadmap draft', r?.snippet);

withList([{ id: 't2' }], { id: 't2', messages: [rsvpMsg] });
check('calendar-only thread -> null (honest empty)', (await getLatestThreadWith('a@b.com')) === null);

withList([{ id: 't3' }], { id: 't3', messages: [icsMsg] });
check('auto-generated + text/calendar (no known sender) -> null', (await getLatestThreadWith('a@b.com')) === null);

withList([{ id: 't4' }], { id: 't4', messages: [ticketMsg] });
check('auto-generated but NOT calendar is kept (CI/ticket mail)', (await getLatestThreadWith('a@b.com'))?.subject === '[CI] build failed');

withList([], null);
check('no threads at all -> null', (await getLatestThreadWith('a@b.com')) === null);

// --- 3. empty vs degraded routing (the requirement) -------------------------
console.log('\n=== honest-empty vs degraded routing ===');
// Mirror orchestrator.collectEmails: allSettled -> fulfilled-null contributes
// nothing to threads AND nothing to failedFor; only a REJECTION degrades.
async function collectLike(results) {
  const settled = await Promise.allSettled(results);
  const threads = [], failedFor = [];
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') { if (res.value) threads.push(res.value); }
    else failedFor.push(`p${i}@x.com`);
  });
  return { threads, failedFor };
}

withList([{ id: 't2' }], { id: 't2', messages: [rsvpMsg] });
const filteredOnly = await collectLike([getLatestThreadWith('p0@x.com')]);
check('filtered-out attendee produces NO thread', filteredOnly.threads.length === 0);
check('filtered-out attendee is NOT marked degraded', filteredOnly.failedFor.length === 0, JSON.stringify(filteredOnly.failedFor));

routes = [{ match: listUrl, reject: true }];
const errored = await collectLike([getLatestThreadWith('p0@x.com').catch((e) => { throw e; })]);
check('a genuinely failed query IS marked degraded', errored.failedFor.length === 1);

// buildCard consequence: degraded=false + no thread => summary null => the
// panel renders "No recent email with this attendee."
check('card fields imply honest-empty (degraded false, no thread)',
  filteredOnly.failedFor.includes('p0@x.com') === false && filteredOnly.threads.length === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

