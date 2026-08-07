/**
 * LIVE check against generativelanguage — the thing the mocked harness could
 * not do. Sends the SHIPPING schema (imported from contract.js, not a copy)
 * to the real endpoint.
 *
 *   node verify-live.mjs            -> bogus key: proves the schema is ACCEPTED
 *                                      by Google's proto (the exact 400 we fixed).
 *   node verify-live.mjs <API_KEY>  -> real key: also generates and validates
 *                                      a full briefing round-trip.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { buildBriefingSchema, DIALECT, normalizeBriefing, SYSTEM_PROMPT, wrapPayload, buildPayload } =
  await import(`file://${SRC.replace(/\\/g, '/')}/background/providers/contract.js`);

const KEY = process.argv[2];
const MODEL = process.env.MPF_MODEL ?? 'gemini-3.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Realistic shape: 2 attendees, 1 document — same fixture as the unit harness.
const payload = buildPayload({
  event: { summary: 'Design sync', description: 'Review the Q3 roadmap and agree scope', start: { dateTime: '2026-08-07T14:00:00Z' }, location: '' },
  attendees: [
    { email: 'ada@example.com', displayName: 'Ada', responseStatus: 'accepted' },
    { email: 'ben@example.com', displayName: 'Ben', responseStatus: 'needsAction' },
  ],
  threads: [{ email: 'ada@example.com', subject: 'Roadmap draft', from: 'Ada <ada@example.com>', date: 'Mon, 3 Aug 2026 09:12:00 +0000', snippet: 'Sending the Q3 roadmap draft ahead of our sync - the scope section still needs your call.', messageCount: 3 }],
  failedFor: ['ben@example.com'],
  documents: [{ name: 'Q3 Roadmap', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-08-01T10:00:00Z', webViewLink: 'https://docs.google.com/document/d/SECRET_URL', owners: [{ displayName: 'Ada' }] }],
});

const schema = buildBriefingSchema(payload.attendees.length, payload.documents.length, DIALECT.GEMINI);
console.log('SHIPPING Gemini schema, index field:');
console.log('  ', JSON.stringify(schema.properties.attendee_context.items.properties.attendee_index));
console.log('   contains additionalProperties:', JSON.stringify(schema).includes('additionalProperties'));

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY ?? 'AIzaSyBOGUS-not-a-real-key-000000000' },
  body: JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: wrapPayload(payload) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 16384 },
  }),
});
const text = await res.text();
let body = {};
try { body = JSON.parse(text); } catch { /* raw */ }
const errMsg = body?.error?.message ?? '';

console.log('\nHTTP', res.status);
if (/API key not valid/i.test(errMsg)) {
  console.log('RESULT: SCHEMA ACCEPTED by Google (rejected only at auth) — the 400 on');
  console.log('        response_schema is gone. Pass a real key to also verify generation.');
  process.exit(0);
}
if (!res.ok) {
  console.log('RESULT: FAILED —', errMsg.replace(/\s+/g, ' ').slice(0, 400));
  process.exit(1);
}

const out = body.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
console.log('finishReason:', body.candidates?.[0]?.finishReason);
console.log('raw model JSON:', out.slice(0, 600));
const parsed = JSON.parse(out);
console.log('\nindex types as returned:',
  'attendee=', typeof parsed.attendee_context?.[0]?.attendee_index,
  'doc=', typeof parsed.document_links?.[0]?.doc_index);

const norm = normalizeBriefing(parsed);
console.log('normalized:', JSON.stringify(norm, null, 2).slice(0, 700));

const ok =
  Array.isArray(norm.core_agenda) &&
  norm.attendee_context.every((a) => Number.isInteger(a.attendee_index) && a.attendee_index < 2) &&
  norm.document_links.every((d) => Number.isInteger(d.doc_index) && d.doc_index < 1) &&
  !out.includes('SECRET_URL');
console.log(`\nRESULT: ${ok ? 'LIVE ROUND-TRIP OK' : 'LIVE ROUND-TRIP INVALID'} (indexes integer + in range, no URL echoed)`);
process.exit(ok ? 0 : 1);
