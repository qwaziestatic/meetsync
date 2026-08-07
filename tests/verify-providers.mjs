/**
 * Phase 5 verification: provider abstraction.
 * Imports the SHIPPING modules and stubs only chrome.storage + fetch.
 * Checks: Anthropic request parity vs Phase 4, Gemini request shape,
 * identical normalized output, and error mapping for both.
 */
const SRC = '../src';

// --- stubs ------------------------------------------------------------------
let storage = {};
let captured = null;
let responder = () => ({ ok: true, status: 200, json: async () => ({}) });

globalThis.chrome = {
  storage: {
    local: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, storage[k]]).filter(([, v]) => v !== undefined)) },
    onChanged: { addListener() {} },
  },
};
globalThis.fetch = async (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  const r = responder(captured);
  return {
    ok: r.ok ?? r.status < 400,
    status: r.status,
    json: async () => r.body ?? {},
  };
};

const { synthesizeBriefing, LlmError } = await import(`${SRC}/background/llm.js`);

// --- fixture ----------------------------------------------------------------
const INPUT = {
  event: { summary: 'Design sync', description: 'Review the Q3 roadmap', start: { dateTime: '2026-08-07T14:00:00Z' }, location: '' },
  attendees: [
    { email: 'a@example.com', displayName: 'Ada', responseStatus: 'accepted' },
    { email: 'b@example.com', displayName: 'Ben', responseStatus: 'needsAction' },
  ],
  threads: [{ email: 'a@example.com', subject: 'Roadmap draft', from: 'Ada', date: 'Mon, 3 Aug 2026', snippet: 'here is the draft', messageCount: 3 }],
  failedFor: ['b@example.com'],
  documents: [{ name: 'Q3 Roadmap', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-08-01T10:00:00Z', webViewLink: 'https://docs.google.com/d/SECRET', owners: [{ displayName: 'Ada' }] }],
};

const MODEL_OUT = {
  core_agenda: ['Review the Q3 roadmap'],
  attendee_context: [{ attendee_index: 0, last_communication: 'Ada sent the roadmap draft.' }],
  document_links: [{ doc_index: 0, relevance: 'the roadmap under review' }],
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` â€” ${extra}` : ''}`);
  cond ? pass++ : fail++;
};

// --- 1. Anthropic path: request parity with Phase 4 -------------------------
console.log('\n=== Anthropic request parity ===');
storage = { anthropicApiKey: 'sk-ant-test', llmProvider: 'anthropic' };
responder = () => ({ status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(MODEL_OUT) }] } });
let out = await synthesizeBriefing(INPUT);

check('endpoint unchanged', captured.url === 'https://api.anthropic.com/v1/messages', captured.url);
check('x-api-key header', captured.init.headers['x-api-key'] === 'sk-ant-test');
check('anthropic-version header', captured.init.headers['anthropic-version'] === '2023-06-01');
check('default model = claude-sonnet-5', captured.body.model === 'claude-sonnet-5', captured.body.model);
check('max_tokens 16000', captured.body.max_tokens === 16000);
check('adaptive thinking on sonnet', captured.body.thinking?.type === 'adaptive');
check('output_config json_schema', captured.body.output_config?.format?.type === 'json_schema');
check('payload wrapped in <meeting_data>', captured.body.messages[0].content.startsWith('<meeting_data>'));
check('normalized output matches model output', JSON.stringify(out) === JSON.stringify(MODEL_OUT));

const aSchema = captured.body.output_config.format.schema;
check('attendee_index integer enum [0,1]', JSON.stringify(aSchema.properties.attendee_context.items.properties.attendee_index) === JSON.stringify({ type: 'integer', enum: [0, 1] }));
check('doc_index integer enum [0]', JSON.stringify(aSchema.properties.document_links.items.properties.doc_index) === JSON.stringify({ type: 'integer', enum: [0] }));
check('additionalProperties false at root', aSchema.additionalProperties === false);
check('NO document URL in prompt', !captured.body.messages[0].content.includes('SECRET'));

// legacy model key migration
storage = { anthropicApiKey: 'sk-ant-test', llmModel: 'claude-opus-4-8' };
await synthesizeBriefing(INPUT);
check('legacy llmModel migrates to anthropic slot', captured.body.model === 'claude-opus-4-8', captured.body.model);
check('haiku omits thinking', await (async () => {
  storage = { anthropicApiKey: 'k', llmModelByProvider: { anthropic: 'claude-haiku-4-5' } };
  await synthesizeBriefing(INPUT);
  return captured.body.thinking === undefined;
})());

// --- 2. Gemini path ---------------------------------------------------------
console.log('\n=== Gemini request ===');
storage = { geminiApiKey: 'AIza-test', llmProvider: 'gemini' };
responder = () => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(MODEL_OUT) }] } }] } });
const gOut = await synthesizeBriefing(INPUT);

check('generativelanguage endpoint', captured.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'), captured.url);
check('default model gemini-3.5-flash-lite', captured.url.includes('gemini-3.5-flash-lite'), captured.url);
check('x-goog-api-key header used', captured.init.headers['x-goog-api-key'] === 'AIza-test');
check('key NOT in query string', !captured.url.includes('key='), captured.url);
check('responseMimeType json', captured.body.generationConfig.responseMimeType === 'application/json');
check('system_instruction present', Boolean(captured.body.system_instruction?.parts?.[0]?.text));
check('NO document URL in prompt', !JSON.stringify(captured.body.contents).includes('SECRET'));

// NOTE: the Phase 5 harness asserted the two schemas were byte-identical.
// That invariant was FALSE and, with fetch stubbed, structurally incapable of
// catching the live 400 â€” it only proved our code matched our own intent.
// It is replaced by dialect-specific assertions derived from live probes
// (see probe-gemini*.mjs) plus the live schema check in verify-live.mjs.
const gSchema = captured.body.generationConfig.responseSchema;
const gIdx = gSchema.properties.attendee_context.items.properties.attendee_index;
check('gemini index enum values are STRINGS (proto requires repeated string)', gIdx.enum.every((v) => typeof v === 'string'), JSON.stringify(gIdx));
check('gemini index enum covers same value set', gIdx.enum.join() === '0,1');
check('gemini sends NO additionalProperties anywhere', !JSON.stringify(gSchema).includes('additionalProperties'));
check('anthropic STILL sends integer enums', aSchema.properties.attendee_context.items.properties.attendee_index.enum.every((v) => typeof v === 'number'));
check('anthropic STILL sends additionalProperties:false', aSchema.additionalProperties === false);
check('normalized output identical across providers', JSON.stringify(gOut) === JSON.stringify(out));

// Gemini returns string indexes in practice â€” normalization must yield ints.
console.log('\n=== index normalization (Gemini string indexes) ===');
storage = { geminiApiKey: 'AIza-test', llmProvider: 'gemini' };
responder = () => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
  core_agenda: ['x'],
  attendee_context: [{ attendee_index: '0', last_communication: 'ok' }],
  document_links: [{ doc_index: '0', relevance: 'r' }],
}) }] } }] } });
const strOut = await synthesizeBriefing(INPUT);
check('string "0" -> integer 0', strOut.attendee_context[0].attendee_index === 0);
check('doc "0" -> integer 0', strOut.document_links[0].doc_index === 0);
check('normalized shape identical to what an integer-index provider yields',
  JSON.stringify(strOut) === JSON.stringify({
    core_agenda: ['x'],
    attendee_context: [{ attendee_index: 0, last_communication: 'ok' }],
    document_links: [{ doc_index: 0, relevance: 'r' }],
  }), JSON.stringify(strOut));

const rejects = async (value) => {
  responder = () => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    core_agenda: [], attendee_context: [{ attendee_index: value, last_communication: 'x' }], document_links: [],
  }) }] } }] } });
  const r = await synthesizeBriefing(INPUT);
  return r.attendee_context.length === 0;
};
for (const bad of ['1e0', '01', ' 1', '1.0', '+1', '', 'one', null, 1.5, '0x1']) {
  check(`rejects non-canonical index ${JSON.stringify(bad)}`, await rejects(bad));
}
check('accepts canonical "1"', !(await rejects('1')));
check('accepts integer 1', !(await rejects(1)));

// --- 3. Provider resolution -------------------------------------------------
console.log('\n=== provider resolution ===');
const whichProvider = async (store) => {
  storage = store;
  responder = (c) => c.url.includes('anthropic')
    ? { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MODEL_OUT) }] } }
    : { status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(MODEL_OUT) }] } }] } };
  await synthesizeBriefing(INPUT);
  return captured.url.includes('anthropic') ? 'anthropic' : 'gemini';
};
check('only gemini key -> gemini (no radio flip needed)', await whichProvider({ geminiApiKey: 'g' }) === 'gemini');
check('only anthropic key -> anthropic', await whichProvider({ anthropicApiKey: 'a' }) === 'anthropic');
check('both keys + explicit choice wins', await whichProvider({ anthropicApiKey: 'a', geminiApiKey: 'g', llmProvider: 'gemini' }) === 'gemini');
check('both keys, no choice -> default anthropic', await whichProvider({ anthropicApiKey: 'a', geminiApiKey: 'g' }) === 'anthropic');
check('cross-provider model id is not sent', await (async () => {
  storage = { geminiApiKey: 'g', llmProvider: 'gemini', llmModelByProvider: { gemini: 'claude-opus-4-8' } };
  await synthesizeBriefing(INPUT);
  return captured.url.includes('gemini-3.5-flash-lite');
})());

// --- 4. Error mapping -------------------------------------------------------
console.log('\n=== error mapping ===');
const codeFor = async (store, resp) => {
  storage = store;
  responder = () => resp;
  try { await synthesizeBriefing(INPUT); return 'no-error'; }
  catch (e) { return e instanceof LlmError ? e.code : `not-LlmError:${e.message}`; }
};
const A = { anthropicApiKey: 'k' };
const G = { geminiApiKey: 'k', llmProvider: 'gemini' };

check('anthropic 401 -> bad_key', await codeFor(A, { status: 401, body: { error: { message: 'bad key' } } }) === 'bad_key');
check('anthropic 429 -> rate_limit', await codeFor(A, { status: 429, body: {} }) === 'rate_limit');
check('anthropic max_tokens -> truncated', await codeFor(A, { status: 200, body: { stop_reason: 'max_tokens', content: [] } }) === 'truncated');
check('anthropic refusal -> refusal', await codeFor(A, { status: 200, body: { stop_reason: 'refusal', content: [] } }) === 'refusal');
check('no key -> missing_key', await codeFor({ llmProvider: 'gemini' }, { status: 200, body: {} }) === 'missing_key');

check('gemini 429 -> rate_limit', await codeFor(G, { status: 429, body: { error: { message: 'Quota exceeded' } } }) === 'rate_limit');
check('gemini 400 API_KEY_INVALID -> bad_key', await codeFor(G, { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } }) === 'bad_key');
check('gemini 403 -> bad_key', await codeFor(G, { status: 403, body: { error: { message: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' } } }) === 'bad_key');
check('gemini promptFeedback.blockReason -> safety', await codeFor(G, { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }) === 'safety');
check('gemini finishReason SAFETY -> safety', await codeFor(G, { status: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } }) === 'safety');
check('gemini finishReason MAX_TOKENS -> truncated', await codeFor(G, { status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } }) === 'truncated');
check('gemini empty candidates -> safety (not parse)', await codeFor(G, { status: 200, body: { candidates: [] } }) === 'safety');
check('gemini empty text -> safety', await codeFor(G, { status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '  ' }] } }] } }) === 'safety');
check('gemini bad JSON -> parse', await codeFor(G, { status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] } }) === 'parse');
check('gemini 500 -> api', await codeFor(G, { status: 500, body: { error: { message: 'internal' } } }) === 'api');
check('errors carry provider tag', await (async () => {
  storage = G; responder = () => ({ status: 429, body: {} });
  try { await synthesizeBriefing(INPUT); return false; } catch (e) { return e.provider === 'gemini'; }
})());

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

