import { useEffect, useState } from 'react';
import {
  LOCAL_KEYS,
  PROVIDERS,
  DEFAULT_PROVIDER,
  getProvider,
  resolveModelId,
  STORAGE_KEYS,
} from '../../shared/messages.js';
import ProviderChoice from './ProviderChoice.jsx';

/**
 * In-panel settings route. Deliberately NOT a separate options page: every
 * setting here is adjusted in the flow of using the panel (key rejected ->
 * fix it; briefing feels slow -> drop a tier; hit a rate limit -> switch
 * provider), and an options_page would mean another HTML entry and another
 * surface to keep the "panel never calls external APIs" audit over.
 *
 * Reads/writes chrome.storage directly — config is extension-internal state,
 * not an external call, so the architectural rule is intact.
 */
export default function SettingsView({ onBack }) {
  const [providerId, setProviderId] = useState(DEFAULT_PROVIDER);
  const [keys, setKeys] = useState({}); // { [storageKey]: rawKey }
  const [modelByProvider, setModelByProvider] = useState({});
  const [flags, setFlags] = useState({});
  const [clearedNote, setClearedNote] = useState(false);

  async function setFlag(key, value) {
    setFlags((prev) => ({ ...prev, [key]: value }));
    await chrome.storage.local.set({ [key]: value });
  }

  useEffect(() => {
    chrome.storage.local
      .get([
        LOCAL_KEYS.PROVIDER,
        LOCAL_KEYS.MODEL_BY_PROVIDER,
        LOCAL_KEYS.LEGACY_LLM_MODEL,
        LOCAL_KEYS.DOC_CONTENT,
        LOCAL_KEYS.SPLASH_DISABLED,
        ...Object.values(PROVIDERS).map((p) => p.keyStorageKey),
      ])
      .then((stored) => {
        setFlags({
          [LOCAL_KEYS.DOC_CONTENT]: Boolean(stored[LOCAL_KEYS.DOC_CONTENT]),
          [LOCAL_KEYS.SPLASH_DISABLED]: Boolean(stored[LOCAL_KEYS.SPLASH_DISABLED]),
        });
        setProviderId(getProvider(stored[LOCAL_KEYS.PROVIDER]).id);
        setKeys(
          Object.fromEntries(
            Object.values(PROVIDERS)
              .map((p) => [p.keyStorageKey, stored[p.keyStorageKey]])
              .filter(([, v]) => v),
          ),
        );
        // Same legacy migration the dispatcher does, so the UI shows what
        // will actually run rather than a stale default.
        const byProvider = { ...(stored[LOCAL_KEYS.MODEL_BY_PROVIDER] ?? {}) };
        if (!byProvider.anthropic && stored[LOCAL_KEYS.LEGACY_LLM_MODEL]) {
          byProvider.anthropic = stored[LOCAL_KEYS.LEGACY_LLM_MODEL];
        }
        setModelByProvider(byProvider);
      });
  }, []);

  const provider = getProvider(providerId);
  const activeModel = resolveModelId(providerId, modelByProvider[providerId]);

  async function pickProvider(id) {
    setProviderId(id);
    // Pin the newly-selected provider's model to a value valid FOR IT — an
    // incompatible model id left over from the other provider would 404 at
    // synthesis time. resolveModelId falls back to that provider's default.
    const next = { ...modelByProvider, [id]: resolveModelId(id, modelByProvider[id]) };
    setModelByProvider(next);
    await chrome.storage.local.set({
      [LOCAL_KEYS.PROVIDER]: id,
      [LOCAL_KEYS.MODEL_BY_PROVIDER]: next,
    });
  }

  async function pickModel(id) {
    const next = { ...modelByProvider, [providerId]: id };
    setModelByProvider(next);
    await chrome.storage.local.set({ [LOCAL_KEYS.MODEL_BY_PROVIDER]: next });
  }

  async function saveKey(storageKey, value) {
    await chrome.storage.local.set({ [storageKey]: value });
    setKeys((prev) => ({ ...prev, [storageKey]: value }));
  }

  async function removeKey(storageKey) {
    await chrome.storage.local.remove(storageKey);
    setKeys((prev) => {
      const next = { ...prev };
      delete next[storageKey];
      return next;
    });
  }

  async function clearBriefings() {
    // Only the pipeline checkpoint/card — the selected event and auth state
    // stay, so the next Generate is a clean full run for the same meeting.
    await chrome.storage.session.remove(STORAGE_KEYS.BRIEFING);
    setClearedNote(true);
    setTimeout(() => setClearedNote(false), 2500);
  }

  return (
    <div className="settings">
      <button className="btn btn--ghost settings__back" onClick={onBack}>
        ← Back
      </button>

      <section>
        <h3 className="card__heading">Provider</h3>
        <ProviderChoice
          value={providerId}
          onChange={pickProvider}
          name="settingsProvider"
          keyed={keys}
        />
      </section>

      {/* Keys for BOTH providers are always shown: they're stored under
          separate keys, so switching provider never destroys the other. */}
      {Object.values(PROVIDERS).map((p) => (
        <ProviderKeySection
          key={p.id}
          provider={p}
          savedKey={keys[p.keyStorageKey]}
          onSave={(value) => saveKey(p.keyStorageKey, value)}
          onRemove={() => removeKey(p.keyStorageKey)}
        />
      ))}

      <section>
        <h3 className="card__heading">{provider.label} model</h3>
        <div role="radiogroup" aria-label={`${provider.label} model`}>
          {provider.models.map((m) => (
            <label className="settings__model" key={m.id}>
              <input
                type="radio"
                name="model"
                checked={activeModel === m.id}
                onChange={() => pickModel(m.id)}
              />
              <span>
                <strong>{m.label}</strong>
                {m.id === provider.defaultModel && ' (default)'}
                {m.freeTier && <span className="settings__badge">free tier</span>}
                <span className="settings__hint"> — {m.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {/* The provider-level data-use warning now lives inside the selected
            provider block above, at the point of choosing. */}
      </section>

      <section>
        <h3 className="card__heading">Document contents</h3>
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={Boolean(flags[LOCAL_KEYS.DOC_CONTENT])}
            onChange={(e) => setFlag(LOCAL_KEYS.DOC_CONTENT, e.target.checked)}
          />
          <span>Read the contents of relevant Drive documents</span>
        </label>
        {/* One honest sentence about what enabling this sends where — the
            user should not have to open the README to learn it. */}
        <p className="settings__warning">
          Off by default. When on, text from up to 3 relevant documents (Docs,
          Slides, Sheets and plain-text files) is sent to{' '}
          <strong>{provider.label}</strong> along with the meeting details —
          not just the file names.
          {providerId === 'gemini' && ' On Gemini’s free tier that text falls under Google’s product-improvement and human-review terms.'}
          {' '}Google will ask you to reconnect and approve broader Drive
          access the first time you use it.
        </p>
      </section>

      <section>
        <h3 className="card__heading">Splash screen</h3>
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={!flags[LOCAL_KEYS.SPLASH_DISABLED]}
            onChange={(e) => setFlag(LOCAL_KEYS.SPLASH_DISABLED, !e.target.checked)}
          />
          <span>Show the animated splash when the panel opens</span>
        </label>
        <p className="settings__hint">
          Full presentation once per browser session; a brief fade after that.
          Click or press any key to skip.
        </p>
      </section>

      <section>
        <h3 className="card__heading">Cached briefings</h3>
        <button className="btn btn--ghost" onClick={clearBriefings}>
          Clear cached briefing
        </button>
        {clearedNote && <p className="settings__hint" role="status">Cleared.</p>}
      </section>
    </div>
  );
}

function ProviderKeySection({ provider, savedKey, onSave, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  async function commit() {
    const value = draft.trim();
    if (!value) return;
    await onSave(value);
    setDraft('');
    setEditing(false);
  }

  return (
    <section>
      <h3 className="card__heading">{provider.label} API key</h3>
      {savedKey && !editing && (
        <div className="settings__keyrow">
          <code className="settings__mask">{maskKey(savedKey)}</code>
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>Change</button>
          <button className="btn btn--ghost btn--danger" onClick={onRemove}>Remove</button>
        </div>
      )}
      {(!savedKey || editing) && (
        <div className="keyform">
          <input
            type="password"
            placeholder={provider.keyPlaceholder}
            value={draft}
            aria-label={`${provider.label} API key`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          <div className="settings__keyrow">
            <button className="btn" onClick={commit} disabled={!draft.trim()}>Save</button>
            {editing && (
              <button className="btn btn--ghost" onClick={() => setEditing(false)}>Cancel</button>
            )}
          </div>
          <p className="settings__hint">
            From{' '}
            <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
              {provider.keySource}
            </a>
            . Stored only on this device (chrome.storage.local).
          </p>
        </div>
      )}
    </section>
  );
}

function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '•••';
}
