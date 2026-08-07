/**
 * Diagnostic: dump the headers Google Calendar actually puts on invitation /
 * RSVP / update mail in YOUR mailbox, so the filter in googleApi.js can be
 * confirmed or extended against real data rather than documentation.
 *
 * This cannot run in Node — it needs the extension's Gmail OAuth token.
 * PASTE IT INTO THE SERVICE WORKER CONSOLE:
 *   chrome://extensions -> Meeting Pre-Flight Assistant -> "service worker"
 *
 * It is read-only: one threads.list plus a few threads.get, metadata format
 * (no message bodies are fetched).
 */
(async () => {
  const { token } = await chrome.identity.getAuthToken({ interactive: true });
  const api = async (path) => {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  };

  // Deliberately UNfiltered: we want the noise, that's the point.
  const q = encodeURIComponent('has:attachment filename:invite.ics OR from:calendar-notification@google.com');
  const list = await api(`/threads?q=${q}&maxResults=5`);
  if (!list.threads?.length) {
    console.log('No calendar-looking mail found. Try a mailbox with a recent invite/RSVP.');
    return;
  }

  const wanted = ['Subject', 'From', 'Sender', 'Reply-To', 'Return-Path', 'Date',
                  'Auto-Submitted', 'Content-Type', 'Precedence', 'X-Google-Calendar-Event-Id'];
  const params = `format=metadata&${wanted.map((h) => `metadataHeaders=${h}`).join('&')}`;

  for (const ref of list.threads) {
    const thread = await api(`/threads/${ref.id}?${params}`);
    const last = thread.messages?.at(-1);
    const headers = Object.fromEntries(
      (last?.payload?.headers ?? []).map((h) => [h.name, h.value]),
    );
    console.log('─'.repeat(70));
    console.log('snippet :', (last?.snippet ?? '').slice(0, 120));
    for (const h of wanted) if (headers[h]) console.log(`${h.padEnd(24)}: ${headers[h]}`);
  }

  console.log('─'.repeat(70));
  console.log('Report the From / Sender / Auto-Submitted / Content-Type values above.');
  console.log('If Sender is NOT calendar-notification@google.com, add that address to');
  console.log('CALENDAR_SENDERS in src/background/googleApi.js.');

  // ── Open empirical question: can Gmail's search grammar exclude this mail?
  // `from:` provably cannot (From is the attendee). `filename:invite.ics` is
  // the only remaining candidate. Test it directly rather than assuming.
  const probe = list.threads[0].id;
  const first = await api(`/threads/${probe}?format=metadata&metadataHeaders=From`);
  const other = first.messages?.[0]?.payload?.headers?.find((h) => h.name === 'From')?.value ?? '';
  const addr = (other.match(/<([^>]+)>/)?.[1] ?? other).trim();
  if (!addr) return;

  const run = async (q) => (await api(`/threads?q=${encodeURIComponent(q)}&maxResults=25`)).threads?.map((t) => t.id) ?? [];
  const base = `(from:${addr} OR to:${addr}) -in:chats`;
  const withoutFilter = await run(base);
  const withIcs = await run(`${base} -filename:invite.ics`);

  console.log('\n─── query-level filter test ───────────────────────────────');
  console.log('counterparty        :', addr);
  console.log('threads, no filter  :', withoutFilter.length);
  console.log('threads, -filename:invite.ics:', withIcs.length);
  console.log('calendar thread still present with the filter:', withIcs.includes(probe));
  console.log(
    withIcs.includes(probe)
      ? '=> -filename:invite.ics does NOT exclude RSVP mail. The result-level\n   Sender check is what carries the filtering (as designed).'
      : '=> -filename:invite.ics DOES exclude it, saving a fetch. Result-level\n   filtering still carries correctness.',
  );
})();
