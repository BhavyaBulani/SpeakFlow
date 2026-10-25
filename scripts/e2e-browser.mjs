import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Real-browser end-to-end verification, self-contained.
 *
 * Why it spawns the server itself: a long-running server cannot outlive the tool
 * command that started it (the process tree is reaped), and a detached process is
 * unreliable across turns. Owning the server as a child here means start -> test ->
 * kill all happen inside one bounded command that terminates.
 *
 * Proves what jsdom and HTTP probes cannot:
 *   1. the built bundle executes and React actually mounts
 *   2. "Start live assistance" reaches the API and enters Listening
 *   3. a PROVISIONAL reply appears while the utterance is still in progress
 *   4. a REFINED reply replaces it when the utterance completes
 *   5. Stop returns the UI to Stopped
 *
 * Uses the simulated transcript provider (labelled in the UI) plus the server's
 * mock AI, so no provider credentials are needed.
 */

const BASE = 'http://localhost:8787';
const results = [];
const pass = (msg) => results.push(`PASS  ${msg}`);
const fail = (msg) => results.push(`FAIL  ${msg}`);

// ---------------------------------------------------------------- server ----

const serverLog = [];
const server = spawn('node', ['dist/server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, MOCK_AI: '1', NODE_ENV: 'development', PORT: '8787' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

let serverExited = false;
server.on('exit', (code) => {
  serverExited = true;
  if (code !== 0 && code !== null) serverLog.push(`server exited with code ${code}\n`);
});

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) return false;
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  return false;
}

// ------------------------------------------------------------------ run ----

let exitCode = 0;
let browser = null;

try {
  const healthy = await waitForHealth();
  if (!healthy) {
    fail('server did not become healthy');
    console.log(results.join('\n'));
    console.log('--- server output ---\n' + serverLog.join(''));
    server.kill();
    process.exit(1);
  }
  pass('server healthy on ' + BASE);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const assetResponses = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} -> ${request.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.endsWith('.js') || url.endsWith('.css')) {
      assetResponses.push(`${response.status()} ${url}`);
    }
  });

  // Preselect the demo provider: no microphone, no provider key required.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'speakflow.settings.v1',
      JSON.stringify({
        provider: 'simulated',
        captureMode: 'demo',
        tone: 'professional',
        accessToken: '',
        userContext: '',
        showHindi: true,
      }),
    );
  });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

  // ---- 1. mount ---------------------------------------------------------------
  const startButton = page.getByRole('button', { name: /start live assistance/i });
  let mounted = true;
  try {
    await startButton.waitFor({ state: 'visible', timeout: 15000 });
    pass('React mounted: "Start live assistance" is visible');
  } catch {
    mounted = false;
    fail('React did NOT mount: start button never appeared');
  }

  if (!mounted) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    results.push(`      page text: ${JSON.stringify(bodyText)}`);
    results.push(`      page errors: ${pageErrors.length === 0 ? '(none)' : pageErrors.join(' | ')}`);
    results.push(`      console errors: ${consoleErrors.length === 0 ? '(none)' : consoleErrors.slice(0, 5).join(' | ')}`);
    results.push(`      failed requests: ${failedRequests.length === 0 ? '(none)' : failedRequests.slice(0, 5).join(' | ')}`);
    results.push(`      asset responses: ${assetResponses.length === 0 ? '(none)' : assetResponses.slice(0, 5).join(' | ')}`);
    throw new Error('mount failed');
  }

  const shellGone = await page.evaluate(() => document.getElementById('boot-shell') === null);
  shellGone ? pass('boot shell replaced by the app') : fail('boot shell still present after mount');

  // ---- 2. panels --------------------------------------------------------------
  for (const label of ['Your script', 'Client transcript', 'Say it in English']) {
    const visible = await page.getByText(label, { exact: false }).first().isVisible();
    visible ? pass(`panel "${label}" visible`) : fail(`panel "${label}" missing`);
  }

  // A control that cannot act yet must be disabled, not silently inert.
  const copyDisabled = await page.getByRole('button', { name: /copy script/i }).isDisabled();
  copyDisabled ? pass('Copy script is disabled before a reply exists') : fail('Copy script was enabled with no reply');

  // ---- 3. start ---------------------------------------------------------------
  await startButton.click();
  await page.waitForTimeout(2000);
  const listening = await page
    .getByText(/listening|simulated transcript/i)
    .first()
    .isVisible()
    .catch(() => false);
  listening ? pass('session entered Listening state') : fail('did not reach Listening');

  // prompt 2 §6: the pipeline stage must be named, not implied by a spinner.
  try {
    const stageBadge = page.locator('[data-testid="pipeline-stage"]').first();
    await stageBadge.waitFor({ state: 'visible', timeout: 10000 });
    const stageValue = (await stageBadge.getAttribute('data-stage')) ?? '';
    const stageText = (await stageBadge.innerText()).trim();
    ['listening', 'transcribing', 'generating', 'refining'].includes(stageValue)
      ? pass(`pipeline stage is named: "${stageText}" (data-stage="${stageValue}")`)
      : fail(`unexpected pipeline stage "${stageValue}"`);
  } catch {
    fail('no pipeline stage indicator rendered');
  }

  // ---- 4. provisional reply while still speaking ------------------------------
  // Selectors are scoped to the script card's state, deliberately not to the badge
  // words: those also appear in the explainer list, which made an earlier version
  // of this test pass before any reply existed.
  const scriptCard = page.locator('.script-card');
  try {
    await page
      .locator('.script-card[data-stage="provisional"] .script-text')
      .first()
      .waitFor({ state: 'visible', timeout: 25000 });
    const provisionalText = (await page.locator('.script-card .script-text').first().innerText()).trim();
    pass(`LIVE SUGGESTION appeared mid-utterance: "${provisionalText}"`);

    // Prove it really was still in progress: a partial segment coexists with it.
    const partials = await page.locator('.segment-partial').count();
    partials > 0
      ? pass('partial (in-progress) transcript text was visible at the same moment')
      : fail('no partial transcript segment when the live suggestion appeared');

    const badgeText = (await page.getByTestId('script-stage').innerText()).trim();
    /live suggestion/i.test(badgeText) && /still listening/i.test(badgeText)
      ? pass(`reply is labelled exactly "Live suggestion · still listening"`)
      : fail(`expected the "Live suggestion · still listening" label, saw "${badgeText}"`);
  } catch {
    fail('LIVE SUGGESTION reply never appeared');
  }

  // ---- 5. refined reply after completion -------------------------------------
  try {
    await page
      .locator('.script-card[data-stage="refined"] .script-text')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 });
    const refinedText = (await page.locator('.script-card .script-text').first().innerText()).trim();
    pass(`SUGGESTED REPLY appeared after completion: "${refinedText}"`);

    const refinedBadge = (await page.getByTestId('script-stage').innerText()).trim();
    /suggested reply/i.test(refinedBadge)
      ? pass('reply is labelled exactly "Suggested reply"')
      : fail(`expected the "Suggested reply" label, saw "${refinedBadge}"`);

    const stage = await scriptCard.getAttribute('data-stage');
    stage === 'refined' ? pass('script card switched from provisional to refined') : fail(`stage is ${stage}`);
  } catch {
    fail('SUGGESTED REPLY reply never appeared');
  }

  // ---- 6. finals -------------------------------------------------------------
  // Wait for the first utterance to actually finish, then require final segments.
  try {
    await page.locator('.segment-final').first().waitFor({ state: 'visible', timeout: 20000 });
    const finals = await page.locator('.segment-final').count();
    pass(`${finals} finalised transcript segment(s) rendered`);
  } catch {
    fail('no finalised transcript segments rendered');
  }

  // ---- 7. stop ---------------------------------------------------------------
  await page.getByRole('button', { name: /^stop$/i }).click();
  await page.waitForTimeout(800);
  const stopped = await page.getByText(/^stopped$/i).first().isVisible().catch(() => false);
  stopped ? pass('Stop returned the UI to Stopped') : fail('Stop did not update state');

  // ---- 8. noise --------------------------------------------------------------
  pageErrors.length === 0 ? pass('no uncaught page exceptions') : fail(`uncaught exceptions: ${pageErrors.join(' | ')}`);
  const realErrors = consoleErrors.filter((t) => !/favicon|fonts\.googleapis|404/i.test(t));
  realErrors.length === 0 ? pass('no console errors') : fail(`console errors: ${realErrors.slice(0, 3).join(' | ')}`);

  await page.screenshot({ path: '.e2e-workspace.png', fullPage: true });
  results.push('screenshot written to .e2e-workspace.png');

  // Also exercise a narrow viewport to satisfy the responsive requirement.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const startVisibleMobile = await startButton.isVisible();
  startVisibleMobile
    ? pass('layout usable at 390px: controls still visible')
    : fail('controls disappeared at 390px width');
  await page.screenshot({ path: '.e2e-mobile.png', fullPage: true });
  results.push('screenshot written to .e2e-mobile.png');

  await context.close();

  // ---- 9. extension bridge reports its absence honestly ---------------------
  // Selecting the extension source with no extension present must NOT sit on
  // "Connecting" forever. It must say what is missing and how to fix it.
  const bridgeContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bridgePage = await bridgeContext.newPage();
  await bridgePage.addInitScript(() => {
    window.localStorage.setItem(
      'speakflow.settings.v1',
      JSON.stringify({
        provider: 'extension-bridge',
        captureMode: 'tab',
        tone: 'professional',
        accessToken: '',
        userContext: '',
        showHindi: true,
      }),
    );
  });

  await bridgePage.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await bridgePage.getByRole('button', { name: /start live assistance/i }).click();

  try {
    // The provider's handshake timeout is 15s; allow a little slack.
    await bridgePage
      .getByText(/no audio arrived from the chrome extension/i)
      .first()
      .waitFor({ state: 'visible', timeout: 22000 });
    pass('extension mode without the extension: honest error instead of a stuck Connecting state');

    const hintVisible = await bridgePage
      .getByText(/start capturing/i)
      .first()
      .isVisible()
      .catch(() => false);
    hintVisible
      ? pass('error includes actionable recovery instructions')
      : fail('error message did not explain how to fix it');
  } catch {
    fail('extension mode hung without reporting that the extension was missing');
  }

  await bridgeContext.close();
} catch (error) {
  fail(`run aborted: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  server.kill();
}

if (results.some((line) => line.startsWith('FAIL'))) exitCode = 1;

console.log(results.join('\n'));
if (exitCode !== 0) {
  console.log('--- server output ---');
  console.log(serverLog.join('').slice(-3000));
}
process.exit(exitCode);
