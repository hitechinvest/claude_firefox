/**
 * Background half of the proxy that gives extension *pages* the shimmed APIs.
 *
 * The shims live in the background page, but `sidepanel.html` and
 * `options.html` are separate contexts that load the same bundle — and that
 * bundle reaches for `chrome.debugger.onEvent` while initialising, which on
 * Firefox is a TypeError that kills the panel before React renders.
 *
 * The emulated namespaces cannot simply be duplicated per context: they own
 * global state (debugger sessions, the offscreen iframe) and register
 * browser-wide listeners.  So pages get a thin client that forwards calls here
 * (ff-page/proxy-client.js), and this module runs them against the real shims
 * and broadcasts their events back.
 */

const { NATIVE, log, warn } = globalThis.__ffPort;

/** Only these are reachable from a page — everything else stays background-only. */
const PROXIED = {
  debugger: ['attach', 'detach', 'sendCommand', 'getTargets'],
  offscreen: ['createDocument', 'hasDocument', 'closeDocument'],
  sidePanel: ['setOptions', 'getOptions', 'open', 'setPanelBehavior', 'getPanelBehavior'],
};

const FORWARDED_EVENTS = [
  ['debugger', 'onEvent'],
  ['debugger', 'onDetach'],
];

function callShim(namespace, method, args) {
  return new Promise((resolve) => {
    const target = globalThis.chrome[namespace];
    if (!target || typeof target[method] !== 'function') {
      resolve({ ok: false, error: `chrome.${namespace}.${method} is not available` });
      return;
    }
    try {
      target[method](...args, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message } : { ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
    }
  });
}

NATIVE.runtime.onMessage.addListener((message, sender) => {
  if (message?.__ffProxy !== 'call') return undefined;

  const { namespace, method, args = [] } = message;
  const allowed = PROXIED[namespace];
  if (!allowed || !allowed.includes(method)) {
    warn('rejected proxy call', namespace, method, 'from', sender.url);
    return Promise.resolve({
      ok: false,
      error: `chrome.${namespace}.${method} is not proxied to extension pages`,
    });
  }

  log('proxy call', namespace, method);
  return callShim(namespace, method, args);
});

/**
 * Push shim events out to every other extension context.  Rejection just means
 * nothing is listening — no page is open, which is the normal case.
 */
for (const [namespace, event] of FORWARDED_EVENTS) {
  const source = globalThis.chrome[namespace]?.[event];
  if (!source?.addListener) continue;
  source.addListener((...args) => {
    NATIVE.runtime
      .sendMessage({ __ffProxy: 'event', namespace, event, args })
      .catch(() => {});
  });
}
