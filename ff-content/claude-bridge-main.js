/**
 * Page-world stub of `chrome.runtime` for claude.ai (MAIN world, document_start).
 *
 * The Claude web app feature-detects the browser extension by calling
 * `chrome.runtime.sendMessage(<extension id>, {type: 'ping'})`.  Firefox exposes
 * no `chrome` object to web content, so without this the web app concludes the
 * extension is not installed and never hands over the OAuth redirect, locale or
 * side-panel host info.
 *
 * Only the members the web app actually uses are provided; everything else is
 * absent rather than faked, so code that probes for more fails the same way it
 * would on a browser without the extension.
 */

(() => {
  'use strict';

  const CHANNEL = '__ffClaudeBridge';
  const EXTENSION_ID = '__FF_EXTENSION_ID__';
  const RESPONSE_TIMEOUT_MS = 30_000;

  // A real Chrome-style runtime is already here (another extension, or a
  // Chromium-based browser) — leave it alone.
  if (window.chrome?.runtime?.id) return;

  /** id -> {resolve, reject, timer} */
  const pending = new Map();
  let nextId = 1;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true || data.kind !== 'response') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.response);
    else entry.reject(new Error(String(data.error ?? 'message failed')));
  });

  function send(message) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('no response from the Claude extension'));
      }, RESPONSE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ [CHANNEL]: true, kind: 'request', id, message }, '*');
    });
  }

  const runtime = {
    id: EXTENSION_ID,

    /**
     * Accepts Chrome's overloads: (extensionId, message[, options][, callback])
     * and (message[, options][, callback]).
     */
    sendMessage(...args) {
      let callback;
      if (typeof args[args.length - 1] === 'function') callback = args.pop();
      // Drop the leading extension id when present; there is only one target.
      const message = typeof args[0] === 'string' ? args[1] : args[0];

      const promise = send(message);
      if (!callback) return promise;

      promise.then(
        (response) => {
          runtime.lastError = undefined;
          callback(response);
        },
        (error) => {
          runtime.lastError = { message: String(error?.message ?? error) };
          try {
            callback(undefined);
          } finally {
            runtime.lastError = undefined;
          }
        },
      );
      return undefined;
    },

    lastError: undefined,
  };

  const chromeStub = window.chrome ?? {};
  chromeStub.runtime = runtime;
  window.chrome = chromeStub;
})();
