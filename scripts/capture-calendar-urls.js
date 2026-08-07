/**
 * Diagnostic: record what Google Calendar URLs actually look like as you move
 * around, and whether our background extractor can read an event id from each.
 *
 * The URL patterns in src/background/eventUrl.js could not be verified from
 * outside an authenticated browser session — this closes that gap with real
 * data from your account.
 *
 * PASTE INTO THE CALENDAR TAB'S CONSOLE (F12 on calendar.google.com — the
 * page console, not the extension's). Then walk through:
 *   day view -> click an event -> close it
 *   week view -> click an event
 *   month view -> click an event
 *   search for something -> click a result
 *   open an event's full page (double-click, or "More options")
 *   page forward a week, open settings and come back
 * Then run  __mpfUrls.report()
 */
(() => {
  const seen = [];

  // Mirrors eventUrl.js — kept inline so this runs standalone in the page.
  const decode = (raw) => {
    try {
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const text = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const space = text.indexOf(' ');
      if (space <= 0) return { error: 'no separator', text };
      const trailer = text.slice(space + 1);
      if (!trailer.includes('@')) return { error: 'not an event chip', text };
      return { eventId: text.slice(0, space), trailer, text };
    } catch {
      return { error: 'not base64' };
    }
  };

  const extract = (href) => {
    const url = new URL(href);
    const eid = url.searchParams.get('eid');
    if (eid) return { via: 'eid', ...decode(eid) };
    const segs = url.pathname.split('/').filter(Boolean);
    const i = segs.findIndex((s) => s === 'eventedit' || s === 'event');
    if (i >= 0 && segs[i + 1]) return { via: segs[i], ...decode(segs[i + 1]) };
    return { via: null };
  };

  const record = (label) => {
    const href = location.href;
    if (seen.length && seen[seen.length - 1].href === href) return;
    const result = extract(href);
    seen.push({ label, href, result });
    console.log(
      `%c${result.eventId ? '✓ id' : '· none'}%c ${href}`,
      `color:${result.eventId ? '#1e8e3e' : '#9aa0a6'};font-weight:600`,
      'color:inherit',
      result.eventId ? { eventId: result.eventId, trailer: result.trailer, via: result.via } : (result.via ? result : ''),
    );
  };

  record('initial');
  // Calendar navigates via history API; patch both plus popstate.
  for (const fn of ['pushState', 'replaceState']) {
    const original = history[fn];
    history[fn] = function patched(...args) {
      const out = original.apply(this, args);
      setTimeout(() => record(fn), 0);
      return out;
    };
  }
  window.addEventListener('popstate', () => setTimeout(() => record('popstate'), 0));
  window.addEventListener('hashchange', () => setTimeout(() => record('hashchange'), 0));

  globalThis.__mpfUrls = {
    record,
    all: () => seen,
    report() {
      const withId = seen.filter((s) => s.result.eventId);
      console.log('\n=== Calendar URL capture ===');
      console.log(`${seen.length} distinct URLs, ${withId.length} carried a usable event id\n`);
      for (const s of seen) {
        console.log(`${s.result.eventId ? '✓' : '·'} [${s.label}] ${s.href}`);
        if (s.result.eventId) console.log(`    eventId=${s.result.eventId}  trailer=${s.result.trailer}  via=${s.result.via}`);
        else if (s.result.via) console.log(`    matched route "${s.result.via}" but decode failed: ${s.result.error}`);
      }
      console.log('\nPaste this output back to confirm or correct the patterns in eventUrl.js.');
      return seen;
    },
  };

  console.log('[mpf] URL capture armed. Navigate around Calendar, then run __mpfUrls.report()');
})();
