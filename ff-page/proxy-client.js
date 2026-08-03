/**
 * Page half of the proxy — see ff-shim/70-proxy-host.js.
 *
 * Installs `chrome.debugger`, `chrome.offscreen` and `chrome.sidePanel` into
 * extension pages.  Calls are forwarded to the background, where the real
 * shims run; events come back over `runtime.onMessage`.
 *
 * Signatures follow Chrome's: the last argument may be a callback, and errors
 * arrive through `chrome.runtime.lastError` rather than an exception, because
 * that is what the bundle checks.
 */

const { NATIVE, registerNamespace, invokeCallback, makeEvent, warn } = globalThis.__ffPort;

const NAMESPACES = {
  debugger: {
    methods: ['attach', 'detach', 'sendCommand', 'getTargets'],
    events: ['onEvent', 'onDetach'],
  },
  offscreen: {
    methods: ['createDocument', 'hasDocument', 'closeDocument'],
    events: [],
    extras: {
      Reason: {
        TESTING: 'TESTING',
        AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
        IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
        DOM_SCRAPING: 'DOM_SCRAPING',
        BLOBS: 'BLOBS',
        DOM_PARSER: 'DOM_PARSER',
        USER_MEDIA: 'USER_MEDIA',
        DISPLAY_MEDIA: 'DISPLAY_MEDIA',
        WEB_RTC: 'WEB_RTC',
        CLIPBOARD: 'CLIPBOARD',
        LOCAL_STORAGE: 'LOCAL_STORAGE',
        WORKERS: 'WORKERS',
        BATTERY_STATUS: 'BATTERY_STATUS',
        MATCH_MEDIA: 'MATCH_MEDIA',
        GEOLOCATION: 'GEOLOCATION',
      },
    },
  },
  sidePanel: {
    methods: ['setOptions', 'getOptions', 'open', 'setPanelBehavior', 'getPanelBehavior'],
    events: [],
  },
};

/** namespace -> event name -> event object, for dispatching what the host sends. */
const eventRegistry = new Map();

function forward(namespace, method, args) {
  return NATIVE.runtime.sendMessage({ __ffProxy: 'call', namespace, method, args });
}

function makeMethod(namespace, method) {
  return function (...args) {
    let callback;
    if (typeof args[args.length - 1] === 'function') callback = args.pop();

    const promise = forward(namespace, method, args).then((response) => {
      if (!response) throw new Error('the background page did not answer');
      if (!response.ok) throw new Error(response.error ?? 'proxied call failed');
      return response.result;
    });

    if (!callback) return promise;
    promise.then(
      (result) => invokeCallback(callback, [result], null),
      (error) => invokeCallback(callback, [undefined], error),
    );
    return undefined;
  };
}

for (const [namespace, spec] of Object.entries(NAMESPACES)) {
  const shim = { ...(spec.extras ?? {}) };
  for (const method of spec.methods) shim[method] = makeMethod(namespace, method);

  const events = new Map();
  for (const name of spec.events) {
    const event = makeEvent(`${namespace}.${name}`);
    shim[name] = event;
    events.set(name, event);
  }
  eventRegistry.set(namespace, events);

  registerNamespace(namespace, shim);
}

NATIVE.runtime.onMessage.addListener((message) => {
  if (message?.__ffProxy !== 'event') return undefined;
  const event = eventRegistry.get(message.namespace)?.get(message.event);
  if (!event) {
    warn('no local listener set for', message.namespace, message.event);
    return undefined;
  }
  event.dispatch(...(message.args ?? []));
  return undefined;
});
