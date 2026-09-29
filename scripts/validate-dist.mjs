import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const manifestPath = join(dist, 'manifest.json');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) fail('dist/manifest.json is missing; run npm run build first.');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`dist/manifest.json is not valid JSON: ${error.message}`);
}

const requiredFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
].filter(Boolean);

const missing = requiredFiles.filter((file) => !existsSync(join(dist, file)));
if (missing.length > 0) fail(`manifest references missing files: ${missing.join(', ')}`);

if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');
if (!manifest.background?.service_worker) fail('background.service_worker is missing.');
if (manifest.background?.type !== 'module') fail('background.type must be module.');

console.log(`PASS dist package is valid (${requiredFiles.length} manifest files checked)`);
