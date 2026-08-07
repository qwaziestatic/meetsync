/**
 * Gemini responseSchema dialect probe — the experiment behind the schema
 * choices in src/background/providers/contract.js.
 *
 * Gemini validates the request schema BEFORE the API key, so schema
 * acceptance is testable without credentials: "API key not valid" means the
 * schema PARSED; a 400 naming a response_schema path means it was REJECTED.
 *
 *   node scripts/probe-gemini-dialect.mjs [apiKey]
 *
 * Re-run this (not the docs) whenever the schema needs to change.
 */
const KEY = process.argv[2] ?? 'AIzaSyBOGUS-not-a-real-key-000000000000000';
const MODEL = process.env.MPF_MODEL ?? 'gemini-3.5-flash-lite';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const wrap = (idxSchema) => ({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { idx: idxSchema, note: { type: 'string' } },
        required: ['idx', 'note'],
      },
    },
  },
  required: ['items'],
});

const variants = {
  "B': integer type + STRING enum values": wrap({ type: 'integer', enum: ['0', '1'] }),
  "C': string  type + STRING enum values": wrap({ type: 'string', enum: ['0', '1'] }),
  "D': integer type, no enum": wrap({ type: 'integer' }),
  "E': integer + minimum/maximum": wrap({ type: 'integer', minimum: 0, maximum: 1 }),
  "G': integer + string enum + description": wrap({
    type: 'integer',
    enum: ['0', '1'],
    description: 'index of the attendee',
  }),
  "H': propertyOrdering present": {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { idx: { type: 'string', enum: ['0', '1'] }, note: { type: 'string' } },
          required: ['idx', 'note'],
          propertyOrdering: ['idx', 'note'],
        },
      },
    },
    required: ['items'],
  },
};

for (const [name, schema] of Object.entries(variants)) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Return one item with idx 0 and note "hi".' }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 2048,
    },
  };
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let msg = '';
    let out = '';
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ?? '';
      out = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    } catch {
      msg = text.slice(0, 200);
    }
    const verdict = /API key not valid/i.test(msg)
      ? 'SCHEMA PARSED (blocked only at auth)'
      : res.status === 200
        ? `ACCEPTED + GENERATED -> ${out.slice(0, 100)}`
        : `SCHEMA REJECTED: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`;
    console.log(`\n--- ${name}\n    ${res.status}  ${verdict}`);
  } catch (err) {
    console.log(`\n--- ${name}\n    NETWORK ERROR: ${err?.message ?? err}`);
  }
}
