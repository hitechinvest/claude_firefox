/**
 * `runtime.onMessageExternal` without `externally_connectable`.
 *
 * Chrome lets claude.ai call `chrome.runtime.sendMessage(<extension id>, …)`
 * straight from the page.  Firefox has no such channel at all, so the port
 * rebuilds it out of parts it does have:
 *
 *   page (MAIN world)  --postMessage-->  content script  --runtime.sendMessage-->  here
 *
 * `ff-content/claude-bridge-main.js` puts a `chrome.runtime.sendMessage` stub on
 * the page, `ff-content/claude-bridge.js` relays it, and this module hands it to
 * whatever registered with `onMessageExternal`.
 *
 * The relay only runs on the origins the manifest lists for those content
 * scripts, so the origin check the extension performs on `sender.origin`
 * remains meaningful — a page cannot claim to be claude.ai when it is not.
 */

const { NATIVE, registerRuntimeMember, warn } = globalThis.__ffPort;

/** How long a listener may take before we give the page an empty answer. */
const RESPONSE_TIMEOUT_MS = 30_000;

function makeExternalEvent(name) {
  const listeners = new Set();
  return {
    listeners,
    name,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
  };
}

const onMessageExternal = makeExternalEvent('onMessageExternal');
const onConnectExternal = makeExternalEvent('onConnectExternal');

registerRuntimeMember('onMessageExternal', onMessageExternal);
registerRuntimeMember('onConnectExternal', onConnectExternal);

/** Shape the relayed sender like the one Chrome hands to an external listener. */
function externalSender(sender) {
  const url = sender.url ?? '';
  let origin = sender.origin;
  if (!origin) {
    try {
      origin = new URL(url).origin;
    } catch {
      origin = undefined;
    }
  }
  const out = { url, origin, frameId: sender.frameId };
  // Chrome leaves `tab` undefined when the sender is not a tab — the extension
  // reads exactly that to tell its own side panel from an ordinary page.
  if (sender.tab) out.tab = sender.tab;
  return out;
}

function dispatchExternal(message, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const respond = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let asyncResponsePending = false;
    for (const listener of [...onMessageExternal.listeners]) {
      try {
        if (listener(message, sender, respond) === true) asyncResponsePending = true;
      } catch (err) {
        warn('onMessageExternal listener threw', err);
      }
    }

    if (!asyncResponsePending) respond(undefined);
    else setTimeout(() => respond(undefined), RESPONSE_TIMEOUT_MS);
  });
}

NATIVE.runtime.onMessage.addListener((message, sender) => {
  if (message?.__ffExternal !== 'message') return undefined;
  if (!onMessageExternal.hasListeners()) return Promise.resolve(undefined);
  return dispatchExternal(message.message, externalSender(sender));
});
