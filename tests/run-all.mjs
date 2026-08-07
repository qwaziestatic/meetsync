/**
 * Runs every verification suite and reports a combined result.
 *   npm test
 *
 * These are plain Node scripts, not a test framework: each imports the real
 * shipping modules and stubs only the browser boundary (`chrome`, `fetch`).
 * No jsdom, no extension host, no network — they run in about a second.
 *
 * Deliberate limit: mocks cover OUR logic only. Whether an external service
 * accepts a request is answered by the live scripts in scripts/, after a
 * mocked assertion about Gemini's schema turned out to be both false and
 * unfalsifiable. See the README's "Don't verify a wire format with a mocked
 * transport" note.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['verify-decode.mjs', 'data-eventid decode, validators, chip filtering'],
  ['verify-providers.mjs', 'provider dispatch, schema dialects, error mapping'],
  ['verify-calendar-filter.mjs', 'Calendar-notification filtering, empty vs degraded'],
  ['verify-doccontent.mjs', 'document text extraction + injection boundary'],
  ['verify-injection.mjs', 'content-script injection, Calendar URL extraction'],
];

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });

let failed = 0;
let totalChecks = 0;

for (const [file, description] of SUITES) {
  const { code, out } = await run(file);
  const lines = out.split('\n');
  // Count the assertions themselves rather than trusting each script's
  // closing summary — not every suite prints one, and a suite that dies
  // early would otherwise report a reassuring zero.
  const passed = lines.filter((l) => l.startsWith('PASS')).length;
  const failures = lines.filter((l) => l.startsWith('FAIL'));
  totalChecks += passed;

  if (code === 0 && failures.length === 0) {
    console.log(`✓ ${file.padEnd(28)} ${String(passed).padStart(3)} checks  — ${description}`);
  } else {
    failed += 1;
    console.log(`✗ ${file.padEnd(28)} FAILED (exit ${code}) — ${description}`);
    console.log(failures.map((l) => `    ${l}`).join('\n') || `    ${out.trim().split('\n').at(-1)}`);
  }
}

console.log(
  `\n${failed === 0 ? 'All suites passed' : `${failed} suite(s) failed`} — ${totalChecks} checks total`,
);
process.exit(failed === 0 ? 0 : 1);
