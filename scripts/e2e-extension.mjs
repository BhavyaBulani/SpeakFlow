import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Attempts to load the unpacked extension in a real Chromium and prove that
 * Chrome accepts the manifest and registers the MV3 service worker.
 *
 * Why this is worth doing: a manifest Chrome rejects fails silently in normal
 * use — the extension simply does not appear, and the user has no idea why.
 * This catches that before a user hits it.
 *
 * HONEST LIMIT: this does NOT prove tabCapture, the offscreen document, or
 * WebRTC work. Those need a real meeting tab and a provider key. The script says
 * exactly which of those it could and could not exercise.
 */

const EXTENSION_DIR = path.join(process.cwd(), 'extension');
const browsersRoot = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');

const results = [];
const pass = (m) => results.push(`PASS  ${m}`);
const fail = (m) => results.push(`FAIL  ${m}`);
const note = (m) => results.push(`NOTE  ${m}`);

// Extensions need the full Chromium build; the headless shell cannot load them.
let hasFullChromium = false;
if (fs.existsSync(browsersRoot)) {
  const builds = fs.readdirSync(browsersRoot);
  hasFullChromium = builds.some((name) => /^chromium-\d+$/.test(name));
  note(`installed browser builds: ${builds.join(', ')}`);
}

if (!hasFullChromium) {
  note('full Chromium build not installed (only chromium-headless-shell).');
  note('Extensions cannot be loaded in the headless shell.');
  note('Skipping runtime load test. Run: npx playwright install chromium');
  console.log(results.join('\n'));
  process.exit(0);
}

const userDataDir = path.join(process.cwd(), '.e2e-extension-profile');
fs.rmSync(userDataDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  // MV3 extensions do not load in old headless; the new headless mode accepts
  // --headless=new, passed explicitly so no visible window opens on the desktop.
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) {
    try {
      worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    } catch {
      worker = undefined;
    }
  }

  if (worker === undefined) {
    fail('Chrome did not register the extension service worker (manifest likely rejected)');
  } else {
    pass(`service worker registered: ${worker.url()}`);

    // Ask Chrome itself what manifest it accepted.
    const info = await worker.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const commands = [];
      try {
        commands.push(...Object.keys(chrome.permissions?.getAll ? await chrome.permissions.getAll() : {}));
      } catch {
        /* not critical */
      }
      return {
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifest_version,
        permissions: manifest.permissions ?? [],
        hostPermissions: manifest.host_permissions ?? [],
        hasTabCapture: (manifest.permissions ?? []).includes('tabCapture'),
        hasOffscreen: (manifest.permissions ?? []).includes('offscreen'),
        hasOffscreenApi: typeof chrome.offscreen !== 'undefined',
        hasTabCaptureApi: typeof chrome.tabCapture !== 'undefined',
        granted: commands,
      };
    });

    pass(`Chrome accepted manifest "${info.name}" v${info.version} (MV${info.manifestVersion})`);

    info.hasTabCapture ? pass('tabCapture permission present') : fail('tabCapture permission missing');
    info.hasOffscreen ? pass('offscreen permission present') : fail('offscreen permission missing');
    info.hasTabCaptureApi
      ? pass('chrome.tabCapture API available in the service worker')
      : fail('chrome.tabCapture API not available');
    info.hasOffscreenApi
      ? pass('chrome.offscreen API available in the service worker')
      : fail('chrome.offscreen API not available');

    // Popup must be a real page Chrome can open.
    const extensionId = new URL(worker.url()).host;
    const popupPage = await context.newPage();
    const popupUrl = `chrome-extension://${extensionId}/src/popup.html`;
    const popupResponse = await popupPage.goto(popupUrl, { timeout: 15000 }).catch(() => null);

    if (popupResponse === null) {
      fail(`popup page did not load at ${popupUrl}`);
    } else {
      const heading = await popupPage.locator('h1').first().innerText().catch(() => '');
      const startDisabled = await popupPage.locator('#start').isDisabled().catch(() => null);
      heading.includes('SpeakFlow')
        ? pass(`popup rendered with heading "${heading.replace(/\s+/g, ' ').trim()}"`)
        : fail(`popup heading unexpected: "${heading}"`);
      startDisabled === true
        ? note('Start button is disabled on a chrome:// page, as designed')
        : pass('Start button is enabled (a normal page is active)');
      await popupPage.screenshot({ path: '.e2e-extension-popup.png' });
      note('popup screenshot written to .e2e-extension-popup.png');
    }

    await popupPage.close().catch(() => undefined);

    // ---- offscreen document lifecycle --------------------------------------
    // The offscreen document is where tab audio and WebRTC live, because an MV3
    // service worker cannot hold either. If Chrome refuses to create it (wrong
    // reason, bad URL) the whole capture path dies silently, so this is worth
    // proving even without a real meeting tab.
    const offscreen = await worker.evaluate(async () => {
      try {
        const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (existing.length === 0) {
          await chrome.offscreen.createDocument({
            url: 'src/offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'verification: hold the tab audio stream',
          });
        }
        const after = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return { ok: true, count: after.length, urls: after.map((c) => c.documentUrl ?? '') };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    });

    if (!offscreen.ok) {
      fail(`Chrome refused to create the offscreen document: ${offscreen.message}`);
    } else {
      pass(`offscreen document created (${offscreen.count} context) — USER_MEDIA reason accepted`);

      const offscreenUrl = offscreen.urls.find((u) => u.includes('offscreen.html')) ?? '';
      offscreenUrl.includes('offscreen.html')
        ? pass(`offscreen page loaded: ${offscreenUrl.replace(/^chrome-extension:\/\/[^/]+\//, '')}`)
        : fail(`offscreen document URL unexpected: ${offscreenUrl}`);

      // The offscreen script must have registered its message listener and be
      // able to answer, proving it parsed in the real extension context.
      const talked = await worker.evaluate(async () => {
        try {
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'capture:stop' });
          return { ok: true };
        } catch (error) {
          return { ok: false, message: String(error?.message ?? error) };
        }
      });
      talked.ok
        ? pass('offscreen script parsed and handled a message in the real extension context')
        : fail(`could not reach the offscreen script: ${talked.message}`);

      await worker.evaluate(async () => {
        await chrome.offscreen.closeDocument().catch(() => undefined);
      });
      const closed = await worker.evaluate(async () => {
        const remaining = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return remaining.length;
      });
      closed === 0 ? pass('offscreen document closed cleanly') : fail(`offscreen document still open (${closed})`);
    }
  }
} catch (error) {
  fail(`extension load test crashed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await context.close().catch(() => undefined);
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

note('tabCapture of a real meeting tab, getUserMedia on the captured stream, and the WebRTC SDP exchange are NOT covered.');
note('Those require a permitted meeting tab with real audio and OPENAI_API_KEY.');

console.log(results.join('\n'));
process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
