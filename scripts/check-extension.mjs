// Repository-local static checks for the extension package.
//
// Runs the fast, deterministic gates that must pass on every change:
// manifest integrity, referenced-file existence, JS syntax, and a couple of
// regression guards for past security fixes. Firefox-oriented marketplace
// linting is intentionally separate (see `npm run lint:ext`).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------
// 1. Manifest integrity
// ---------------------------------------------------------------------------
const manifestPath = join(root, 'manifest.json');
let manifest;
try {
  manifest = readJson(manifestPath);
  ok('manifest.json parses as JSON');
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}

const referencedFiles = [];
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) {
    fail(`version "${manifest.version}" is not semver (x.y.z)`);
  }

  for (const icon of Object.values(manifest.icons ?? {})) referencedFiles.push(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) referencedFiles.push(icon);
  if (manifest.action?.default_popup) referencedFiles.push(manifest.action.default_popup);
  if (manifest.options_page) referencedFiles.push(manifest.options_page);
  if (manifest.background?.service_worker) referencedFiles.push(manifest.background.service_worker);

  const hostPermissions = manifest.host_permissions ?? [];
  if (hostPermissions.includes('https://*/*') || hostPermissions.includes('<all_urls>')) {
    fail('host_permissions must not request blanket access to https://*/* or <all_urls>');
  }

  const permissions = manifest.permissions ?? [];
  const allowedPermissions = new Set(['activeTab', 'storage']);
  for (const permission of permissions) {
    if (!allowedPermissions.has(permission)) {
      fail(`unexpected permission "${permission}" — extend the allow-list deliberately`);
    }
  }

  if (!manifest.content_security_policy?.extension_pages?.includes("script-src 'self'")) {
    fail('content_security_policy.extension_pages must pin script-src to \'self\'');
  }
}

for (const relative of referencedFiles) {
  if (!existsSync(join(root, relative))) {
    fail(`manifest references missing file: ${relative}`);
  }
}

// ---------------------------------------------------------------------------
// 2. JavaScript syntax (ESM-aware via `node --check`)
// ---------------------------------------------------------------------------
const collectJsFiles = (directory) => {
  const entries = readdirSync(directory);
  const files = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full);
  }
  return files;
};

for (const file of collectJsFiles(root)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`syntax error in ${file.slice(root.length + 1)}\n${result.stderr}`);
  }
}
ok('all JavaScript files pass node --check');

// ---------------------------------------------------------------------------
// 3. Regression guards for past security fixes
// ---------------------------------------------------------------------------
const uiFiles = ['popup/popup.js', 'options/options.js'];
for (const relative of uiFiles) {
  const source = readFileSync(join(root, relative), 'utf8');
  if (/\.innerHTML\s*=/.test(source)) {
    fail(`${relative} assigns innerHTML — render remote data via textContent instead`);
  }
  if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source)) {
    fail(`${relative} uses eval/new Function`);
  }
}
ok('UI files contain no innerHTML/eval sinks');

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
for (const note of notes) console.log(`  ok  ${note}`);

if (failures.length > 0) {
  console.error('\nExtension checks failed:');
  for (const failure of failures) console.error(`  ✗  ${failure}`);
  process.exit(1);
}

console.log('\nAll extension checks passed.');
