import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates the Chrome extension statically.
 *
 * This is honest, bounded verification: it proves the manifest is well-formed,
 * every file it references actually exists, and every script parses. It does NOT
 * prove tabCapture or WebRTC work — that needs a real Chrome with the extension
 * loaded, which is documented as still-unverified in the README.
 *
 * Catches the boring failures that waste a whole debugging session: a typo in a
 * file path, a JSON trailing comma Chrome silently rejects, a syntax error that
 * only surfaces when the service worker is registered.
 */

const EXT_DIR = path.join(process.cwd(), 'extension');
const failures = [];
const passes = [];

function fail(message) {
  failures.push(message);
}
function pass(message) {
  passes.push(message);
}

function mustExist(relative, why) {
  const full = path.join(EXT_DIR, relative);
  if (!fs.existsSync(full)) {
    fail(`missing file: extension/${relative} (${why})`);
    return null;
  }
  pass(`exists: extension/${relative}`);
  return full;
}

// ------------------------------------------------------------ manifest ----

const manifestPath = path.join(EXT_DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('FAIL manifest.json not found');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  pass('manifest.json is valid JSON');
} catch (error) {
  console.error(`FAIL manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, got ${manifest.manifest_version}`);
else pass('manifest_version is 3 (MV3)');

for (const field of ['name', 'version', 'description']) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
    fail(`manifest.${field} must be a non-empty string`);
  }
}
if (!failures.some((line) => line.includes('manifest.name'))) pass('manifest has name, version and description');

// Chrome requires a numeric-dotted version.
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
  fail(`manifest.version "${manifest.version}" is not a dotted numeric version`);
} else {
  pass(`manifest.version "${manifest.version}" is well-formed`);
}

// ------------------------------------------------- referenced resources ----

const serviceWorker = manifest.background?.service_worker;
if (typeof serviceWorker !== 'string') {
  fail('manifest.background.service_worker is required for MV3');
} else {
  const file = mustExist(serviceWorker, 'service worker');
  if (file !== null && !/[.]js$/.test(serviceWorker)) {
    fail('background.service_worker must point at a .js file');
  }
}

if (manifest.background?.type !== 'module') {
  pass('service worker declared as a classic script (no import/export used)');
}

const popupHtml = manifest.action?.default_popup;
if (typeof popupHtml !== 'string') {
  fail('manifest.action.default_popup is required so the user can start capture');
} else {
  mustExist(popupHtml, 'popup');
}

// Follow the <script src> inside each HTML file the manifest points at.
for (const htmlRel of [popupHtml, 'src/offscreen.html']) {
  if (typeof htmlRel !== 'string') continue;
  const full = path.join(EXT_DIR, htmlRel);
  if (!fs.existsSync(full)) continue;

  const html = fs.readFileSync(full, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  if (scripts.length === 0) fail(`extension/${htmlRel} references no script`);

  for (const src of scripts) {
    const resolved = path.join(path.dirname(htmlRel), src).replace(/\\/g, '/');
    mustExist(resolved, `script referenced by ${htmlRel}`);
  }

  if (!html.includes('<title>')) fail(`extension/${htmlRel} has no <title>`);
}

// The content bridge is injected by filename from background.js.
const backgroundFile = path.join(EXT_DIR, serviceWorker ?? 'src/background.js');
if (fs.existsSync(backgroundFile)) {
  const background = fs.readFileSync(backgroundFile, 'utf8');
  const bridgeMatch = background.match(/BRIDGE_PATH\s*=\s*'([^']+)'/);
  if (bridgeMatch === null) {
    fail('background.js does not declare BRIDGE_PATH');
  } else {
    mustExist(bridgeMatch[1], 'content bridge injected on demand');
  }

  // Guard the permission model: the extension must not request <all_urls> up
  // front. App-origin access belongs in optional_host_permissions.
  if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes('<all_urls>')) {
    fail('host_permissions must not include <all_urls> (use optional_host_permissions)');
  } else {
    pass('host_permissions is not <all_urls>');
  }

  // tabCapture + offscreen are both required for the supported audio path.
  for (const permission of ['tabCapture', 'offscreen', 'storage', 'scripting']) {
    const list = manifest.permissions ?? [];
    if (!list.includes(permission)) fail(`manifest.permissions is missing "${permission}"`);
  }
  pass('manifest declares tabCapture, offscreen, storage and scripting');
}

// ------------------------------------------------------------- syntax ----

const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
})(path.join(EXT_DIR, 'src'));

for (const file of jsFiles) {
  const relative = path.relative(process.cwd(), file);
  try {
    // `node --check` parses without executing: no chrome.* needed.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    pass(`parses: ${relative}`);
  } catch (error) {
    const detail = error.stderr?.toString().split('\n').slice(0, 4).join(' ').trim() ?? '';
    fail(`syntax error in ${relative}: ${detail}`);
  }
}

// --------------------------------------------------------------- report ----

for (const line of passes) console.log(`  ok   ${line}`);
if (failures.length > 0) {
  for (const line of failures) console.error(`  FAIL ${line}`);
  console.error(`\ncheck:extension failed - ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`\ncheck:extension OK - manifest valid, ${jsFiles.length} script(s) parsed, all references resolved.`);
console.log('NOTE: runtime behaviour (tabCapture, offscreen, WebRTC) is NOT covered by this check.');
