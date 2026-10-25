/**
 * Extension popup: configuration + explicit start/stop.
 *
 * Capture always begins from a user gesture here, and the target tab is the tab
 * the user is looking at. Nothing is captured in the background.
 */

const DEFAULT_SETTINGS = {
  appUrl: 'http://localhost:5173',
  backendUrl: 'http://localhost:8787/api',
  accessToken: '',
};

const els = {
  appUrl: document.getElementById('appUrl'),
  backendUrl: document.getElementById('backendUrl'),
  accessToken: document.getElementById('accessToken'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  statusText: document.getElementById('statusText'),
  dot: document.getElementById('dot'),
  tabname: document.getElementById('tabname'),
};

let activeTab = null;

function setStatus(text, kind) {
  els.statusText.textContent = text;
  els.dot.className = `dot${kind ? ` ${kind}` : ''}`;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  els.appUrl.value = settings.appUrl;
  els.backendUrl.value = settings.backendUrl;
  els.accessToken.value = settings.accessToken;
  return settings;
}

async function saveSettings() {
  const settings = {
    appUrl: els.appUrl.value.trim() || DEFAULT_SETTINGS.appUrl,
    backendUrl: els.backendUrl.value.trim() || DEFAULT_SETTINGS.backendUrl,
    accessToken: els.accessToken.value.trim(),
  };
  await chrome.storage.local.set({ settings });
  return settings;
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  if (activeTab === null) {
    els.tabname.textContent = 'No active tab found.';
    els.start.disabled = true;
    return;
  }
  const isRestricted =
    typeof activeTab.url === 'string' &&
    (activeTab.url.startsWith('chrome://') ||
      activeTab.url.startsWith('edge://') ||
      activeTab.url.startsWith('about:') ||
      activeTab.url.startsWith('chrome-extension://'));
  els.tabname.textContent = activeTab.title ?? activeTab.url ?? `Tab ${activeTab.id}`;
  els.start.disabled = isRestricted;
  if (isRestricted) {
    setStatus('This is a browser page, not a meeting tab. Open the meeting first.', 'err');
  }
}

/** `chrome.permissions.request` must run from a user gesture (this click). */
async function ensureHostPermission(appUrl) {
  try {
    const origin = new URL(appUrl).origin;
    const already = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

els.start.addEventListener('click', async () => {
  if (activeTab === null || typeof activeTab.id !== 'number') return;
  els.start.disabled = true;
  setStatus('Requesting permission to reach the SpeakFlow app…', 'warn');

  const settings = await saveSettings();

  // Needed so the worker can inject the bridge into the app tab.
  const granted = await ensureHostPermission(settings.appUrl);
  if (!granted) {
    setStatus(
      'Permission to reach the SpeakFlow app was denied. Allow it, or fix the app URL above.',
      'err',
    );
    els.start.disabled = false;
    return;
  }

  setStatus('Starting capture of this tab…', 'warn');
  try {
    await chrome.runtime.sendMessage({ type: 'capture:start', tabId: activeTab.id });
  } catch (error) {
    setStatus(`Could not start: ${error instanceof Error ? error.message : 'unknown error'}`, 'err');
    els.start.disabled = false;
  }
});

els.stop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'capture:stop', detail: 'Stopped from the extension popup.' });
  setStatus('Stopped. Audio capture released.', '');
  els.start.disabled = false;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'popup') return false;
  if (message.type !== 'capture:status') return false;

  const { status, detail } = message;
  const kind = status === 'listening' ? 'on' : status === 'error' ? 'err' : 'warn';
  const label =
    status === 'listening'
      ? 'Listening — audio is streaming for transcription.'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'stopped'
          ? 'Stopped. Audio capture released.'
          : status === 'error'
            ? 'Needs attention.'
            : status;
  setStatus(detail ? `${label} ${detail}` : label, kind);
  if (status === 'listening' || status === 'error' || status === 'stopped') {
    els.start.disabled = status === 'listening';
  }
  return false;
});

void (async () => {
  await loadSettings();
  await refreshActiveTab();
})();
