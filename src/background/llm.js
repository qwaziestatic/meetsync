/**
 * LLM dispatcher. Resolves provider + key + model from chrome.storage.local,
 * builds the provider-neutral payload, and hands off to a provider module.
 *
 * The orchestrator imports only synthesizeBriefing() and LlmError from here
 * and cannot tell which provider ran: every provider returns the same
 * index-based shape, and buildCard() resolves it identically. Adding a
 * provider means adding a module under providers/ and an entry in the
 * PROVIDERS catalog — nothing in this file's callers changes.
 *
 * See providers/contract.js for the interface, the shared system prompt, and
 * the security rationale behind index-selection output.
 */

import { LOCAL_KEYS, getProvider, resolveModelId, PROVIDERS } from '../shared/messages.js';
import { LlmError, buildPayload } from './providers/contract.js';
import * as anthropic from './providers/anthropic.js';
import * as gemini from './providers/gemini.js';

// Re-exported so orchestrator.js keeps importing LlmError from './llm.js'
// exactly as it did in Phase 3 — the refactor is invisible to it.
export { LlmError };

const IMPLEMENTATIONS = { anthropic, gemini };

/**
 * Provider selection:
 *  1. the user's explicit choice, if it has a key configured;
 *  2. otherwise whichever provider DOES have a key (so a first-run user who
 *     pastes a Gemini key never has to also flip a radio button);
 *  3. otherwise the explicit choice (or the default), which will surface the
 *     needs-key state naming that provider.
 */
async function resolveProviderConfig(stored) {
  const chosenId = stored[LOCAL_KEYS.PROVIDER];
  const keyed = Object.values(PROVIDERS).filter((p) => stored[p.keyStorageKey]);

  const chosen = getProvider(chosenId);
  const provider =
    stored[chosen.keyStorageKey] ? chosen : keyed.length === 1 ? keyed[0] : chosen;

  // Model is stored per provider; the Phase 4 single-provider key migrates
  // into the anthropic slot so existing installs keep their choice.
  const byProvider = stored[LOCAL_KEYS.MODEL_BY_PROVIDER] ?? {};
  const candidate =
    byProvider[provider.id] ??
    (provider.id === 'anthropic' ? stored[LOCAL_KEYS.LEGACY_LLM_MODEL] : undefined);

  return {
    provider,
    apiKey: stored[provider.keyStorageKey],
    model: resolveModelId(provider.id, candidate),
  };
}

/**
 * @returns {Promise<{core_agenda: string[],
 *   attendee_context: {attendee_index: number, last_communication: string}[],
 *   document_links: {doc_index: number, relevance: string}[]}>}
 *   Raw index-based output — resolution and bounds-checking happen in
 *   orchestrator.buildCard(), which owns the API-sourced arrays.
 * @throws {LlmError}
 */
export async function synthesizeBriefing({ event, attendees, threads, failedFor, documents }) {
  const stored = await chrome.storage.local.get([
    LOCAL_KEYS.PROVIDER,
    LOCAL_KEYS.MODEL_BY_PROVIDER,
    LOCAL_KEYS.LEGACY_LLM_MODEL,
    ...Object.values(PROVIDERS).map((p) => p.keyStorageKey),
  ]);

  const { provider, apiKey, model } = await resolveProviderConfig(stored);
  if (!apiKey) {
    throw new LlmError(`No ${provider.label} API key configured`, 'missing_key', {
      provider: provider.id,
    });
  }

  const payload = buildPayload({ event, attendees, threads, failedFor, documents });
  return IMPLEMENTATIONS[provider.id].synthesize(payload, { apiKey, model });
}
