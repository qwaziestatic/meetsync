/**
 * Message + storage-key constants shared by all three contexts (content
 * script, background worker, side panel).
 *
 * This module is imported by BOTH Vite build graphs:
 *  - main build (worker + panel): becomes a shared chunk, statically imported
 *    — safe because the worker is declared `"type": "module"`.
 *  - content build: inlined into the IIFE bundle.
 * Keep it dependency-free and side-effect-free so both stay true.
 */

export const MSG = {
  /** content script -> background: user clicked a calendar event chip */
  EVENT_SELECTED: 'mpf/event-selected',
  /** panel -> background: give me the current event context */
  GET_SELECTED_EVENT: 'mpf/get-selected-event',
  /** panel -> background: run the interactive consent flow */
  AUTH_ENSURE: 'mpf/auth-ensure',
  /** panel -> background: start (or resume) the briefing pipeline */
  RUN_BRIEFING: 'mpf/run-briefing',
  /** panel -> background: current briefing state (also kicks stale resume) */
  GET_BRIEFING: 'mpf/get-briefing',
  /** background -> content script: "are you alive?" liveness probe */
  PING_CONTENT: 'mpf/ping-content',
  /**
   * panel -> background: make sure the active Calendar tab has a live content
   * script, and tell me whether it does. Drives the panel's ready/not-listening
   * state so the user never has to guess if the extension is watching.
   */
  ENSURE_CONTENT: 'mpf/ensure-content',
};

/**
 * chrome.storage.session keys. storage.session is the bus between background
 * and panel: the worker writes, the panel reads + watches storage.onChanged.
 * Chosen over runtime messages for state because the panel may open AFTER the
 * event was clicked — storage makes the latest context durable for the
 * browser session without keeping the worker alive.
 */
export const STORAGE_KEYS = {
  /** raw pointer from the content script: { eventId, calendarId, hintTitle } */
  SELECTED_EVENT: 'selectedEvent',
  /** derived state for the panel: { status: 'loading'|'needs-auth'|'ready'|'error', ... } */
  EVENT_CONTEXT: 'eventContext',
  /**
   * briefing pipeline state + checkpoint (see orchestrator.js):
   * { status: 'running'|'ready'|'needs-auth'|'needs-key'|'error',
   *   step, eventId, data: { emails?, documents? }, card?, updatedAt }
   */
  BRIEFING: 'briefing',
  /**
   * Set once the splash has played in this browser session. storage.session
   * is cleared when the browser closes, so "full presentation once per
   * session" needs no expiry logic of our own.
   */
  SPLASH_SHOWN: 'splashShown',
};

/**
 * chrome.storage.LOCAL keys (persist across browser restarts, unlike
 * storage.session). Config only — never derived state.
 */
export const LOCAL_KEYS = {
  /**
   * User-supplied API keys, one storage key per provider so switching
   * providers never destroys the other key. Deliberately NOT bundled: any
   * key shipped inside an extension is extractable by anyone who installs it.
   */
  ANTHROPIC_API_KEY: 'anthropicApiKey',
  GEMINI_API_KEY: 'geminiApiKey',
  /** Selected provider id ('anthropic' | 'gemini'). */
  PROVIDER: 'llmProvider',
  /** true = never show the splash overlay. */
  SPLASH_DISABLED: 'splashDisabled',
  /**
   * true = fetch and summarise Drive document CONTENTS (needs the
   * drive.readonly scope). OFF BY DEFAULT: leaving it off keeps the original
   * privacy posture, where document text never leaves Google.
   */
  DOC_CONTENT: 'readDocumentContents',
  /** { [providerId]: modelId } — model choice is per provider. */
  MODEL_BY_PROVIDER: 'llmModelByProvider',
  /**
   * Phase 4's single-provider model key. Read-only now: migrated into
   * MODEL_BY_PROVIDER.anthropic on first resolve so existing installs keep
   * their choice instead of silently reverting to the default.
   */
  LEGACY_LLM_MODEL: 'llmModel',
};

/**
 * Provider catalog — the single source of truth for the settings UI (panel)
 * and the dispatcher (worker). Adding a provider means adding an entry here
 * plus a module in background/providers/.
 *
 * Model IDs and free-tier eligibility verified 2026-08-06 against
 * ai.google.dev/gemini-api/docs/models and .../pricing. Both Gemini entries
 * are stable (non-preview) and free-tier eligible; the list is deliberately
 * curated to one fast/cheap default plus one higher-capability option rather
 * than mirroring Google's full catalog, which turns over quickly.
 *
 * Cost hints are coarse on purpose — published prices drift, and the useful
 * signal for this decision is the tier, not the exact per-MTok figure.
 */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    descriptor: 'Claude models — paid API, no training on your data',
    keyStorageKey: 'anthropicApiKey',
    keyPlaceholder: 'sk-ant-…',
    keySource: 'Anthropic Console',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet', hint: 'Balanced quality and cost — recommended' },
      { id: 'claude-opus-4-8', label: 'Claude Opus', hint: 'Strongest synthesis, ≈2× Sonnet cost' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku', hint: 'Fastest, ≈⅓ Sonnet cost' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    descriptor: 'Gemini models — free tier available, data stays with Google',
    keyStorageKey: 'geminiApiKey',
    keyPlaceholder: 'AIza…',
    keySource: 'Google AI Studio',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.5-flash-lite',
    models: [
      {
        id: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite',
        hint: 'Fast and cheap — recommended',
        freeTier: true,
      },
      {
        id: 'gemini-3.6-flash',
        label: 'Gemini 3.6 Flash',
        hint: 'Higher capability, slower',
        freeTier: true,
      },
    ],
    /**
     * Shown next to the free-tier options in Settings. Verified 2026-08-06
     * against ai.google.dev/gemini-api/terms: on unpaid Gemini API use,
     * Google "uses [submitted content] to provide, improve, and develop
     * Google products" and "human reviewers may read, annotate, and process"
     * API input and output. Paid-tier use is excluded from both. This
     * extension transmits email subjects and preview snippets, so the user
     * gets that sentence at the moment of choosing, not buried in a README.
     */
    freeTierWarning:
      "Free tier: Google may use submitted content to improve its products, and human reviewers may read it. Your briefings include email subjects and snippets. Enable billing on the API key to opt out.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'anthropic';

/** @returns {object} the provider descriptor, falling back to the default. */
export function getProvider(id) {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

/** @returns {string} a model id valid FOR THAT PROVIDER (never cross-provider). */
export function resolveModelId(providerId, candidate) {
  const provider = getProvider(providerId);
  return provider.models.some((m) => m.id === candidate) ? candidate : provider.defaultModel;
}
