/**
 * Anthropic provider — the Phase 3/4 implementation, moved behind the
 * provider interface with request construction and behavior unchanged.
 *
 * Raw fetch() rather than @anthropic-ai/sdk: this runs in the MV3 service
 * worker, which cold-starts constantly and re-parses its bundle each time,
 * and we need exactly one endpoint. The manifest's host permission makes the
 * extension-context fetch CORS-exempt. Same reasoning applies to Google's
 * SDK in gemini.js.
 */

import {
  LlmError,
  SYSTEM_PROMPT,
  DIALECT,
  wrapPayload,
  buildBriefingSchema,
  parseBriefingJson,
} from './contract.js';

const URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 180_000;
const PROVIDER = 'anthropic';

export async function synthesize(payload, { apiKey, model }) {
  const body = {
    model,
    max_tokens: 16000,
    output_config: {
      format: {
        type: 'json_schema',
        // JSON Schema dialect: integer enums + additionalProperties:false,
        // exactly as shipped in Phase 4/5. Unchanged by the Gemini fix.
        schema: buildBriefingSchema(
          payload.attendees.length,
          payload.documents.length,
          DIALECT.JSON_SCHEMA,
        ),
      },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: wrapPayload(payload) }],
  };

  // Thinking config is model-dependent: Haiku 4.5 predates adaptive thinking
  // (only the removed budget_tokens form) and 400s on {type:"adaptive"}, so
  // omit it there. Sonnet 5 defaults to adaptive; Opus 4.8 needs it explicit.
  if (model !== 'claude-haiku-4-5') body.thinking = { type: 'adaptive' };

  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LlmError(`Anthropic request failed: ${err?.message ?? err}`, 'api', {
      provider: PROVIDER,
    });
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(detail || 'API key was rejected', 'bad_key', { provider: PROVIDER });
    }
    if (res.status === 429) {
      throw new LlmError(
        'Anthropic rate limit reached — wait a moment and retry.',
        'rate_limit',
        { provider: PROVIDER },
      );
    }
    throw new LlmError(
      `Anthropic API ${res.status}${detail ? `: ${detail}` : ''}`,
      'api',
      { provider: PROVIDER },
    );
  }

  const message = await res.json();

  // stop_reason BEFORE content — refusal/truncation can leave content empty
  // or partial even on HTTP 200.
  if (message.stop_reason === 'refusal') {
    throw new LlmError('The model declined to process this content.', 'refusal', {
      provider: PROVIDER,
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new LlmError('Synthesis ran out of output tokens.', 'truncated', { provider: PROVIDER });
  }

  // With output_config.format the text block is schema-valid JSON; thinking
  // blocks may precede it, so find rather than index.
  const text = message.content?.find((b) => b.type === 'text')?.text;
  return parseBriefingJson(text, PROVIDER);
}
