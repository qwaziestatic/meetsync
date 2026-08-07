/** Phase 7 â€” URL extraction + injector logic. Imports shipping modules. */
const SRC = '../src';

let sentMessages = [];
let execCalls = [];
let pingAlive = false;
let queryResult = [];

globalThis.chrome = {
  storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  tabs: {
    query: async () => queryResult,
    sendMessage: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      if (!pingAlive) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { alive: true };
    },
  },
  scripting: { executeScript: async (opts) => { execCalls.push(opts); } },
  runtime: { id: 'test' },
};

const { eventFromCalendarUrl } = await import(`${SRC}/background/eventUrl.js`);
const { ensureContentScript, isCalendarUrl, injectIntoOpenCalendarTabs } =
  await import(`${SRC}/background/injector.js`);

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` â€” ${extra}` : ''}`); c ? pass++ : fail++; };

const b64url = (s) => Buffer.from(s, 'binary').toString('base64url');
const EID = b64url('73krm2k9574js0dnnimu1dkmpb dagimtsegaye014@m');

console.log('=== URL extraction ===');
const eid = eventFromCalendarUrl(`https://calendar.google.com/calendar/u/0/r/eventedit/${EID}?tab=rc`);
check('/r/eventedit/<payload> yields the event id', eid?.eventId === '73krm2k9574js0dnnimu1dkmpb', JSON.stringify(eid));
check('truncated calendar segment discarded (reuses eventId.js rules)', eid?.calendarId === null);

const q = eventFromCalendarUrl(`https://calendar.google.com/calendar/event?eid=${EID}`);
check('?eid= yields the event id', q?.eventId === '73krm2k9574js0dnnimu1dkmpb');
check('source is labelled for the discrepancy log', q?.source === 'url:eid');

const rec = eventFromCalendarUrl(`https://calendar.google.com/calendar/u/0/r/event/${b64url('73krm2k9574js0dnnimu1dkmpb_20260721T150000Z dagim@m')}`);
check('recurring instance suffix preserved', rec?.eventId.endsWith('_20260721T150000Z'), JSON.stringify(rec));

console.log('\n=== URLs that must yield nothing (no guessing) ===');
for (const url of [
  'https://calendar.google.com/calendar/u/0/r/day/2026/8/7',
  'https://calendar.google.com/calendar/u/0/r/week/2026/8/7',
  'https://calendar.google.com/calendar/u/0/r/month/2026/8',
  'https://calendar.google.com/calendar/u/0/r/search?q=standup',
  'https://calendar.google.com/calendar/u/0/r/settings',
  'https://calendar.google.com/calendar/u/0/r',
  'https://mail.google.com/mail/u/0/#inbox',
  'https://evil.example/calendar.google.com/r/eventedit/AAA',
]) {
  check(`null for ${url.slice(0, 62)}`, eventFromCalendarUrl(url) === null);
}
check('null for malformed eid payload', eventFromCalendarUrl('https://calendar.google.com/calendar/event?eid=!!!not-base64!!!') === null);
check('null for eid decoding to a non-event shape', eventFromCalendarUrl(`https://calendar.google.com/calendar/event?eid=${b64url('task_1 tasks')}`) === null);

console.log('\n=== injector: probe then inject ===');
check('isCalendarUrl accepts calendar.google.com', isCalendarUrl('https://calendar.google.com/calendar/u/0/r'));
check('isCalendarUrl rejects lookalike host', !isCalendarUrl('https://calendar.google.com.evil.example/x'));

sentMessages = []; execCalls = []; pingAlive = true;
let r = await ensureContentScript(7, 'https://calendar.google.com/calendar/u/0/r');
check('live script -> no injection', r.alive && !r.injected && execCalls.length === 0);
check('liveness checked via a ping message', sentMessages.length === 1);

sentMessages = []; execCalls = []; pingAlive = false;
r = await ensureContentScript(8, 'https://calendar.google.com/calendar/u/0/r');
check('dead port -> injects', execCalls.length === 1, JSON.stringify(execCalls));
check('injects the built content file', execCalls[0]?.files?.[0] === 'content/calendar.js');
check('targets the top frame only', execCalls[0]?.target?.allFrames === false);
check('reports not-alive when the post-inject ping also fails', r.injected && !r.alive);

execCalls = [];
r = await ensureContentScript(9, 'https://mail.google.com/');
check('non-calendar tab -> never injected', execCalls.length === 0 && r.reason === 'not-calendar');

execCalls = [];
const originalExec = chrome.scripting.executeScript;
chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
r = await ensureContentScript(10, 'https://calendar.google.com/x');
check('injection failure is caught, never thrown', r.alive === false && typeof r.reason === 'string');
chrome.scripting.executeScript = originalExec;

execCalls = []; pingAlive = false;
queryResult = [
  { id: 1, url: 'https://calendar.google.com/calendar/u/0/r/day' },
  { id: 2, url: 'https://calendar.google.com/calendar/u/1/r/week' },
];
await injectIntoOpenCalendarTabs();
check('onInstalled sweep injects into every open calendar tab', execCalls.length === 2, `${execCalls.length}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

