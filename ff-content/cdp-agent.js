/**
 * Isolated-world half of the CDP shim (document_start, all frames).
 *
 * Sits between the background debugger shim and ff-content/cdp-main.js:
 * forwards commands into the page world, forwards page-world events back to the
 * background.  Nothing that needs page internals happens here — this side only
 * exists because the MAIN world has no access to `browser.runtime`.
 */

(() => {
  'use strict';

  const CHANNEL = '__ffCdpMain';
  const REQUEST_TIMEOUT_MS = 5000;

  if (window.__ffCdpAgent) return;
  window.__ffCdpAgent = true;

  const api = globalThis.browser ?? globalThis.chrome;

  /** id -> {resolve, reject, timer} */
  const pending = new Map();
  let nextId = 1;

  function callPage(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`page command '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ [CHANNEL]: true, kind: 'request', id, method, params }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    // Same-window only. Everything in the MAIN world is page-readable, so this
    // is a sanity check rather than a trust boundary — see cdp-main.js.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true) return;

    if (data.kind === 'response') {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.result ?? {});
      else entry.reject(new Error(String(data.error ?? 'page command failed')));
      return;
    }

    if (data.kind === 'event' && typeof data.method === 'string') {
      api.runtime
        .sendMessage({ __ffCdp: 'event', method: data.method, params: data.params ?? {} })
        .catch(() => {
          /* background is asleep or the extension is reloading */
        });
    }
  });

  api.runtime.onMessage.addListener((message) => {
    if (message?.__ffCdp !== 'command') return undefined;
    if (message.method === 'Agent.ping') return Promise.resolve({ ok: true });
    return callPage(message.method, message.params ?? {});
  });
})();
