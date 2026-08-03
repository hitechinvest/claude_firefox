/**
 * Relay for the claude.ai <-> extension channel (isolated world, document_start).
 *
 * Takes what ff-content/claude-bridge-main.js posts from the page world and
 * forwards it to the background, where ff-shim/50-external.js turns it back
 * into an `onMessageExternal` dispatch.
 *
 * The manifest only injects this pair on claude.ai, so the origin the
 * background sees is the real one; the page cannot pick it.
 */

(() => {
  'use strict';

  const CHANNEL = '__ffClaudeBridge';

  if (window.__ffClaudeBridgeRelay) return;
  window.__ffClaudeBridgeRelay = true;

  const api = globalThis.browser ?? globalThis.chrome;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true || data.kind !== 'request') return;

    const reply = (payload) => {
      window.postMessage({ [CHANNEL]: true, kind: 'response', id: data.id, ...payload }, '*');
    };

    api.runtime
      .sendMessage({ __ffExternal: 'message', message: data.message })
      .then(
        (response) => reply({ ok: true, response }),
        (error) => reply({ ok: false, error: String(error?.message ?? error) }),
      );
  });
})();
