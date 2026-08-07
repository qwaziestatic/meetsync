/**
 * Google Gemini provider (generativelanguage.googleapis.com REST API).
 *
 * Auth: the key goes in the `x-goog-api-key` HEADER, never `?key=`. Query
 * strings end up in server logs, proxy logs, and browser history in ways
 * headers do not — and this key is the user's, not ours.
 *
 * Raw fetch() rather than @google/genai, for the same MV3 cold-start
 * reasoning documented in anthropic.js.
 *
 * ── Schema dialect ────────────────────────────────────────────────────────
 * Gemini gets a DIFFERENT schema from Anthropic: string-valued enums and no
 * additionalProperties. Both constraints were established by probing the
 * live endpoint, after a documentation-derived schema 400'd on every real
 * briefing. The full experiment, results, and an honest constraint-strength
 * comparison live in contract.js above buildBriefingSchema() — read that
 * before changing anything here.
 *
 * Index values therefore arrive as strings ("0") and are converted by
 * parseIndex() inside parseBriefingJson(), which accepts only canonical
 * integer forms. buildCard() then bounds-checks the result against the
 * API-sourced arrays exactly as it does for Anthropic, so the Phase 4
 * injection boundary is untouched by the dialect change: the model still
 * cannot express a URL or an identity, only a selection.
 */

import {
  LlmError,
  SYSTEM_PROMPT,
  DIALECT,
  wrapPayload,
  buildBriefingSchema,
  parseBriefingJson,
} from './contract.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 180_000;
const PROVIDER = 'gemini';

/**
 * Generous output budget: current Gemini models think by default and those
 * thinking tokens count against maxOutputTokens, so a tight cap surfaces as
 * a MAX_TOKENS finish rather than a short answer. We deliberately send no
 * thinkingConfig — its shape has changed across model generations, and the
 * defaults are correct for a summarization task.
 */
const MAX_OUTPUT_TOKENS = 16384;

function buildBody(payload, schema) {
  return {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: wrapPayload(payload) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

async function post(model, apiKey, body) {
  return fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      // Header auth, not ?key= — see module header.
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
}

async function readError(res) {
  try {
    const body = await res.json();
    const error = body?.error ?? {};
    return { message: error.message ?? '', status: error.status ?? '' };
  } catch {
    return { message: '', status: '' };
  }
}

export async function synthesize(payload, { apiKey, model }) {
  const schema = buildBriefingSchema(
    payload.attendees.length,
    payload.documents.length,
    DIALECT.GEMINI,
  );

  let res;
  try {
    res = await post(model, apiKey, buildBody(payload, schema));
  } catch (err) {
    throw new LlmError(`Gemini request failed: ${err?.message ?? err}`, 'api', {
      provider: PROVIDER,
    });
  }

  if (!res.ok) {
    const { message, status } = await readError(res);

    // Gemini reports a bad/absent key as 400 INVALID_ARGUMENT with
    // API_KEY_INVALID in the message, or 403 PERMISSION_DENIED when the key
    // is valid but the API isn't enabled for that project. Both are things
    // the user fixes by pasting a different key.
    const looksLikeKeyProblem =
      /api[_ ]?key|api key not valid|permission denied/i.test(message) ||
      status === 'PERMISSION_DENIED' ||
      status === 'UNAUTHENTICATED';

    if (res.status === 429) {
      throw new LlmError(
        'Gemini free-tier rate limit reached — wait a moment and retry.',
        'rate_limit',
        { provider: PROVIDER },
      );
    }
    if (res.status === 401 || res.status === 403 || (res.status === 400 && looksLikeKeyProblem)) {
      throw new LlmError(message || 'API key was rejected', 'bad_key', { provider: PROVIDER });
    }

    // A 400 naming response_schema means our dialect assumptions have gone
    // stale again. There is deliberately NO auto-retry with a relaxed schema:
    // the previous speculative fallback could not have fixed the real bug
    // (it stripped additionalProperties but left the integer enums that also
    // failed), and a silent downgrade to a weaker constraint is exactly the
    // outcome the empirical write-up in contract.js exists to prevent. Fail
    // loudly with Google's own message — it names the offending path.
    throw new LlmError(`Gemini API ${res.status}${message ? `: ${message}` : ''}`, 'api', {
      provider: PROVIDER,
    });
  }

  return readCandidate(await res.json());
}

/**
 * Gemini returns HTTP 200 for outcomes that produced no usable content —
 * a prompt blocked before generation, a candidate stopped by safety filters,
 * or a truncated generation. Each has to be distinguished from a parse
 * failure, because they mean different things to the user: "this content
 * tripped a filter" is not "the extension is broken". Email snippets from
 * arbitrary senders will trip filters occasionally, so this is a normal
 * operating state, not an edge case.
 */
function readCandidate(body) {
  const blockReason = body?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmError(
      `Gemini blocked this meeting's content before generating (${blockReason}). Email text from outside senders can trigger this.`,
      'safety',
      { provider: PROVIDER },
    );
  }

  const candidate = body?.candidates?.[0];
  if (!candidate) {
    throw new LlmError('Gemini returned no candidates.', 'safety', { provider: PROVIDER });
  }

  // STOP is the normal terminal reason. MAX_TOKENS mirrors the Anthropic
  // max_tokens check; SAFETY/RECITATION/PROHIBITED_CONTENT/BLOCKLIST/SPII
  // are filter outcomes; anything else is unexpected but still not JSON.
  const finish = candidate.finishReason;
  if (finish && finish !== 'STOP') {
    if (finish === 'MAX_TOKENS') {
      throw new LlmError('Synthesis ran out of output tokens.', 'truncated', {
        provider: PROVIDER,
      });
    }
    throw new LlmError(
      `Gemini stopped early (${finish}). Email text from outside senders can trigger its content filters.`,
      'safety',
      { provider: PROVIDER },
    );
  }

  const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) {
    throw new LlmError('Gemini returned an empty response.', 'safety', { provider: PROVIDER });
  }
  return parseBriefingJson(text, PROVIDER);
}
