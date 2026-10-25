/**
 * SpeakFlow AI — MV3 service worker.
 *
 * Responsibility split (deliberate):
 *   - this worker owns chrome.tabCapture + the offscreen document lifecycle
 *   - src/offscreen.js owns the audio pipeline and the WebRTC session
 *   - the SpeakFlow web app owns transcription interpretation and the reply
 *     engine, so there is exactly ONE reply pipeline in the product
 *
 * Audio never passes through the SpeakFlow backend: the offscreen document
 * talks WebRTC straight to the provider using a short-lived token minted by our
 * API. The permanent provider key never reaches the extension.
 */

const OFFSCREEN_PATH = 'src/offscreen.html';
const BRIDGE_PATH = 'src/content-bridge.js';
const DEFAULT_APP_URL = 'http://localhost:5173';

let creatingOffscreen = null;
/** Tab whose audio we are capturing (so Stop can badge/clear correctly). */
let capturingTabId = null;

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return {
    appUrl: DEFAULT_APP_URL,
    backendUrl: 'http://localhost:8787/api',
    accessToken: '',
    ...(stored.settings ?? {}),
  };
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color !== undefined) await chrome.action.setBadgeBackgroundColor({ color });
}

async function hasOffscreenDocument() {
  if (typeof chrome.runtime.getContexts !== 'function') return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen !== null) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // USER_MEDIA is required for getUserMedia inside an offscreen document.
    reasons: ['USER_MEDIA'],
    justification:
      'Capture the audio of the meeting tab the user explicitly chose, and stream it for live transcription.',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

async function findAppTab(appUrl) {
  let origin;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(origin)) ?? null;
}

/** Inject the bridge on demand instead of hardcoding the app's origin. */
async function ensureBridge(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'speakflow:ping' });
    if (pong?.ok === true) return true;
  } catch {
    // Not injected yet - fall through.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_PATH] });
    return true;
  } catch (error) {
    console.warn('[speakflow] could not inject bridge', error);
    return false;
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeoutMs);
    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Relay one transcript/status event to the SpeakFlow web app. */
async function deliverToApp(event) {
  const settings = await getSettings();
  let tab = await findAppTab(settings.appUrl);
  if (tab === null) {
    tab = await chrome.tabs.create({ url: settings.appUrl, active: false });
    await waitForTabComplete(tab.id);
  }
  if (typeof tab?.id !== 'number') return;

  const ok = await ensureBridge(tab.id);
  if (!ok) {
    // Tell the popup so the user is not left guessing.
    await chrome.runtime.sendMessage({
      target: 'popup',
      type: 'capture:status',
      status: 'error',
      detail: `Could not reach the SpeakFlow app tab at ${settings.appUrl}. Open it once, then start capture again.`,
    }).catch(() => undefined);
    return;
  }
  await chrome.tabs
    .sendMessage(tab.id, { type: 'speakflow:event', event })
    .catch(() => undefined);
}

async function startCapture(tabId) {
  const settings = await getSettings();
  await ensureOffscreen();

  let streamId;
  try {
    // getMediaStreamId must be called from the extension process, not a page.
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    await chrome.runtime.sendMessage({
      target: 'popup',
      type: 'capture:status',
      status: 'error',
      detail: `Could not capture this tab (${error instanceof Error ? error.message : 'unknown error'}). Reload the tab and try again.`,
    }).catch(() => undefined);
    return;
  }

  capturingTabId = tabId;
  await setBadge('REC', '#c9843f');

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'capture:start',
    streamId,
    settings,
  });
}

async function stopCapture(reason) {
  capturingTabId = null;
  await setBadge('');
  await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'capture:stop' })
    .catch(() => undefined);
  await closeOffscreen();
  if (reason !== undefined) await deliverToApp({ type: 'status', status: 'stopped', detail: reason });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not ours.
  if (message?.target === 'offscreen') return false;

  if (message?.type === 'capture:start' && typeof message.tabId === 'number') {
    void startCapture(message.tabId).catch((error) => {
      console.error('[speakflow] start failed', error);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'capture:stop') {
    void stopCapture(message.detail).catch((error) => {
      console.error('[speakflow] stop failed', error);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'capture:event' && message.event !== undefined) {
    void deliverToApp(message.event);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// If the captured tab is closed or navigates away, stop cleanly and say why.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturingTabId) {
    void stopCapture('The meeting tab was closed, so capture stopped.');
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('');
});
