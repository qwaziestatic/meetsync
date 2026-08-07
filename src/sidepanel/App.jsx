/**
 * Side panel root.
 *
 * Architectural rule (unchanged since Phase 1): the panel NEVER calls Google
 * APIs or the LLM directly. It talks to the background worker via
 * chrome.runtime messages and reads worker-written state from
 * chrome.storage.session; the only direct storage writes are extension-local
 * config (API key, model) and cache clearing.
 *
 * LLM-output rendering rule (Phase 4): model text renders exclusively as JSX
 * text nodes — React escaping is the injection boundary on this side. The
 * single rich-HTML surface is <Description/>, which is DOMPurify-gated and
 * never sees model output.
 */
import { useEffect, useState } from 'react';
import { MSG, STORAGE_KEYS, LOCAL_KEYS, PROVIDERS, getProvider } from '../shared/messages.js';
import MeetingHeader from './components/MeetingHeader.jsx';
import Description from './components/Description.jsx';
import BriefingCard from './components/BriefingCard.jsx';
import BriefingSkeleton from './components/BriefingSkeleton.jsx';
import SettingsView from './components/SettingsView.jsx';
import ProviderChoice from './components/ProviderChoice.jsx';
import Splash from './components/Splash.jsx';

// Auto-refresh policy (Deliverable 3): regenerate only when the user is
// about to need the card AND it's meaningfully old. Both gates matter — the
// 10-min staleness floor is also the double-bill limiter (a 15-min window
// can trigger at most one auto-run, since the fresh card resets the clock).
const REFRESH_WINDOW_MS = 15 * 60_000; // event starts within this
const STALE_BRIEFING_MS = 10 * 60_000; // and the card is older than this
const REFRESH_CHECK_MS = 60_000;

export default function App() {
  const [view, setView] = useState('main'); // 'main' | 'settings'
  const [context, setContext] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  // null = not yet checked. Drives the ready/not-listening empty state.
  const [listening, setListening] = useState(null);

  /**
   * Ask the worker to guarantee a live content script in the active tab.
   * Called on mount (the panel opening is itself a strong signal the user is
   * about to click an event) and from the retry affordance.
   */
  async function checkListening() {
    setListening(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.ENSURE_CONTENT });
      setListening(res?.ok ? res.data : { alive: false });
    } catch {
      setListening({ alive: false });
    }
  }

  useEffect(() => {
    checkListening();
  }, []);

  useEffect(() => {
    let mounted = true;

    chrome.runtime
      .sendMessage({ type: MSG.GET_SELECTED_EVENT })
      .then((res) => {
        if (mounted && res?.ok) setContext(res.data);
      })
      .catch(() => {
        /* worker unreachable during reload — storage listener catches up */
      });

    // Also the resume trigger: if a run died with the worker, this kicks it.
    chrome.runtime
      .sendMessage({ type: MSG.GET_BRIEFING })
      .then((res) => {
        if (mounted && res?.ok) setBriefing(res.data);
      })
      .catch(() => {});

    const onChanged = (changes, area) => {
      if (area !== 'session') return;
      if (changes[STORAGE_KEYS.EVENT_CONTEXT]) {
        setContext(changes[STORAGE_KEYS.EVENT_CONTEXT].newValue ?? null);
      }
      if (changes[STORAGE_KEYS.BRIEFING]) {
        setBriefing(changes[STORAGE_KEYS.BRIEFING].newValue ?? null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  /**
   * Auto-refresh. A plain interval while the panel is mounted — NOT
   * chrome.alarms — because refresh is only meaningful while the panel is
   * open: sidePanel.open() requires a user gesture, so a worker-side alarm
   * regenerating for a closed panel would silently bill the API with nobody
   * looking at the result. The panel being open IS the trigger condition.
   * Effect re-arms on state change, so the closed-over values stay current.
   */
  useEffect(() => {
    function check() {
      if (context?.status !== 'ready' || briefing?.status !== 'ready') return;
      const startMs = Date.parse(context.event.start?.dateTime ?? '');
      if (Number.isNaN(startMs)) return; // all-day events don't auto-refresh
      const untilStart = startMs - Date.now();
      const age = Date.now() - (briefing.generatedAt ?? 0);
      if (untilStart > 0 && untilStart <= REFRESH_WINDOW_MS && age > STALE_BRIEFING_MS) {
        chrome.runtime
          .sendMessage({ type: MSG.RUN_BRIEFING, payload: { auto: true } })
          .catch(() => {});
      }
    }
    check();
    const id = setInterval(check, REFRESH_CHECK_MS);
    return () => clearInterval(id);
  }, [context, briefing]);

  async function connectGoogle() {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.AUTH_ENSURE });
      if (!res?.ok) setAuthError(res?.error?.message ?? 'Authorization failed.');
    } catch (err) {
      setAuthError(String(err?.message ?? err));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <main className="briefing">
      {/* Overlay, not a gate: every data effect above runs behind it, so
          skipping the splash reveals a ready panel rather than a spinner. */}
      <Splash />
      <header className="briefing__header">
        <div>
          <h1>Meeting Pre-Flight</h1>
          <p className="briefing__tagline">Your one-page briefing card</p>
        </div>
        <button
          className="btn btn--icon"
          aria-label={view === 'settings' ? 'Close settings' : 'Settings'}
          onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
        >
          {view === 'settings' ? '✕' : '⚙'}
        </button>
      </header>

      {view === 'settings' ? (
        <SettingsView onBack={() => setView('main')} />
      ) : (
        <Body
          context={context}
          briefing={briefing}
          authBusy={authBusy}
          authError={authError}
          onConnect={connectGoogle}
          listening={listening}
          onRetryListening={checkListening}
        />
      )}
    </main>
  );
}

function Body({ context, briefing, authBusy, authError, onConnect, listening, onRetryListening }) {
  if (!context) {
    return <EmptyState listening={listening} onRetry={onRetryListening} />;
  }

  switch (context.status) {
    case 'loading':
      return (
        <section className="notice">
          <p>Fetching {context.hintTitle ? <strong>{context.hintTitle}</strong> : 'event'}…</p>
        </section>
      );

    case 'needs-auth':
      return (
        <section className="notice">
          <p>
            Connect your Google account to read this event
            {context.hintTitle ? <> (<strong>{context.hintTitle}</strong>)</> : null}.
          </p>
          {context.missingScopes?.length > 0 && (
            <p className="warn">
              Some permissions were declined last time — Calendar, Gmail, and
              Drive are all required for briefings.
            </p>
          )}
          <button className="btn" onClick={onConnect} disabled={authBusy}>
            {authBusy ? 'Waiting for Google…' : 'Connect Google'}
          </button>
          {authError && <p className="warn">{authError}</p>}
        </section>
      );

    case 'error':
      return (
        <section className="notice">
          <p className="warn">Couldn't load the event: {context.message}</p>
        </section>
      );

    case 'ready':
      return (
        <>
          <MeetingHeader event={context.event} />
          <Description text={context.event.description} />
          <BriefingArea
            event={context.event}
            briefing={briefing}
            onConnect={onConnect}
            authBusy={authBusy}
          />
        </>
      );

    default:
      return null;
  }
}

/**
 * The empty state used to be indistinguishable from the broken state: "click
 * an event" reads identically whether the extension is listening or the tab
 * has no live content script. It now reports which, because guessing was the
 * actual user-facing symptom of the manual-refresh bug.
 */
function EmptyState({ listening, onRetry }) {
  if (listening === null) {
    return (
      <section className="notice">
        <p className="status status--checking">Checking this tab…</p>
      </section>
    );
  }

  if (listening.alive) {
    return (
      <section className="notice">
        <p className="status status--ready">
          <span className="status__dot" aria-hidden="true" />
          Ready — click an event on this Calendar tab.
        </p>
      </section>
    );
  }

  if (listening.isCalendar === false) {
    return (
      <section className="notice">
        <p>
          Open <strong>calendar.google.com</strong> and click an event to
          generate a briefing.
        </p>
      </section>
    );
  }

  return (
    <section className="notice">
      <p className="warn">
        Not listening on this tab — clicks won't be detected. This can happen
        right after the extension is reloaded.
      </p>
      <button className="btn" onClick={onRetry}>Retry</button>
      <p className="settings__hint">
        If retrying doesn't help, refresh the Calendar tab.
      </p>
    </section>
  );
}

/** Same state machine as Phase 3, mapped onto the new components. */
function BriefingArea({ event, briefing, onConnect, authBusy }) {
  const generate = () => {
    // Terminal state arrives via the storage watch; fire-and-forget.
    chrome.runtime.sendMessage({ type: MSG.RUN_BRIEFING }).catch(() => {});
  };

  return (
    <section className="pipeline">
      {!briefing && (
        <>
          <QuickAttendees attendees={event.attendees} />
          <button className="btn" onClick={generate}>Generate briefing</button>
        </>
      )}

      {briefing?.status === 'running' && <BriefingSkeleton step={briefing.step} />}

      {briefing?.status === 'needs-auth' && (
        <div className="notice">
          <p className="warn">Google access is missing or incomplete — reconnect to continue.</p>
          <button className="btn" onClick={onConnect} disabled={authBusy}>
            {authBusy ? 'Waiting for Google…' : 'Connect Google'}
          </button>
        </div>
      )}

      {briefing?.status === 'needs-key' && (
        <ApiKeyForm
          provider={getProvider(briefing.provider)}
          rejectionMessage={briefing.message}
          onSaved={generate}
        />
      )}

      {briefing?.status === 'error' && (
        <div className="notice">
          {/* Rate limits and safety blocks are normal operating states, not
              breakage — say so, and keep the same cheap retry (checkpointing
              means it resumes at synthesis, no re-querying Gmail/Drive). */}
          {briefing.llmCode === 'rate_limit' || briefing.llmCode === 'safety' ? (
            <p className="warn">{briefing.message}</p>
          ) : (
            <p className="warn">Briefing failed: {briefing.message}</p>
          )}
          <button className="btn" onClick={generate}>Retry</button>
        </div>
      )}

      {briefing?.status === 'ready' && (
        // Cost guard: reopening the panel shows THIS cached card with its
        // timestamp; a fresh API call only happens via Regenerate or the
        // 15-min/10-min auto rule.
        <BriefingCard
          card={briefing.card}
          generatedAt={briefing.generatedAt}
          auto={briefing.auto}
          onRegenerate={generate}
        />
      )}
    </section>
  );
}

/** Compact pre-generation glance at who's coming (card rows replace this). */
function QuickAttendees({ attendees }) {
  const others = attendees.filter((a) => !a.self);
  if (others.length === 0) return null;
  return (
    <ul className="quick">
      {others.slice(0, 8).map((a) => (
        <li key={a.email}>
          <span className={`event__rsvp event__rsvp--${a.responseStatus || 'unknown'}`} />
          {a.displayName || a.email}
        </li>
      ))}
      {others.length > 8 && <li className="card__none">+{others.length - 8} more</li>}
    </ul>
  );
}

/**
 * The ONE key-entry flow (no second prompt anywhere).
 *
 * First-run subtlety this fixes: provider resolution auto-picks whichever
 * provider HAS a key, but when neither does it falls back to the default —
 * so the very first prompt a Gemini-only user ever saw was hardcoded to
 * Anthropic, with no route to Gemini. When no key exists for any provider we
 * therefore ask which provider first, right here, rather than sending the
 * user to Settings they have no reason to know about.
 */
function ApiKeyForm({ provider: resolvedProvider, rejectionMessage, onSaved }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  // null until storage is read: avoids flashing the chooser at a user who
  // already has keys and is merely replacing a rejected one.
  const [anyKeyExists, setAnyKeyExists] = useState(null);
  const [chosenId, setChosenId] = useState(resolvedProvider.id);

  useEffect(() => {
    chrome.storage.local
      .get(Object.values(PROVIDERS).map((p) => p.keyStorageKey))
      .then((stored) => {
        setAnyKeyExists(Object.values(PROVIDERS).some((p) => stored[p.keyStorageKey]));
      })
      .catch(() => setAnyKeyExists(true)); // fail closed: no chooser, keep resolved provider
  }, []);

  const firstRun = anyKeyExists === false;
  const provider = firstRun ? getProvider(chosenId) : resolvedProvider;

  async function save() {
    if (!key.trim()) return;
    setSaving(true);
    await chrome.storage.local.set({
      [provider.keyStorageKey]: key.trim(),
      // Persist the first-run choice as the explicit preference, so it's
      // durable rather than re-derived from "which key happens to exist".
      ...(firstRun ? { [LOCAL_KEYS.PROVIDER]: provider.id } : {}),
    });
    setKey('');
    setSaving(false);
    onSaved();
  }

  return (
    <div className="keyform">
      <p>
        {rejectionMessage
          ? `The saved ${provider.label} API key was rejected (${rejectionMessage}). Enter a new one:`
          : firstRun
            ? 'Briefing synthesis needs an API key. Choose a provider:'
            : `Briefing synthesis needs your ${provider.label} API key (stored only on this device):`}
      </p>

      {firstRun && (
        <ProviderChoice value={chosenId} onChange={setChosenId} name="firstRunProvider" />
      )}

      <input
        type="password"
        placeholder={provider.keyPlaceholder}
        aria-label={`${provider.label} API key`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <button className="btn" onClick={save} disabled={saving || !key.trim()}>
        Save &amp; generate
      </button>
      <p className="settings__hint">
        Get one from{' '}
        <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
          {provider.keySource}
        </a>
        .
      </p>
      {/* On first run the notice is rendered inside the selected provider
          block above. When the provider is already resolved (replacing a
          rejected key) there is no block, so it belongs here. */}
      {!firstRun && provider.freeTierWarning && (
        <p className="settings__warning">{provider.freeTierWarning}</p>
      )}
    </div>
  );
}
