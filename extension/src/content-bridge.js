/**
 * Content bridge, injected into the SpeakFlow web app tab on demand.
 *
 * One-way for transcript events (extension -> page) plus a stop request back,
 * over window.postMessage so the page never needs to know the extension id.
 * Kept deliberately tiny: all real logic stays in the app and the extension.
 */
(() => {
  const SOURCE = 'speakflow-extension';

  if (window.__speakflowBridgeInstalled === true) return;
  window.__speakflowBridgeInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'speakflow:ping') {
      sendResponse({ ok: true, source: SOURCE });
      return true;
    }
    if (message?.type === 'speakflow:event' && message.event !== undefined) {
      window.postMessage({ source: SOURCE, event: message.event }, window.location.origin);
      sendResponse({ ok: true });
      return true;
    }
    // Not ours. Returning true here would claim an async response that never
    // arrives and log "message port closed" noise for every broadcast.
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    if (data.source !== 'speakflow-app') return;
    if (data.type === 'stop') {
      chrome.runtime
        .sendMessage({ target: 'background', type: 'capture:stop', detail: null })
        .catch(() => undefined);
    }
  });
})();
