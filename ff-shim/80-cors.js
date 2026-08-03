/**
 * Drop the `Origin` header from the extension's own requests to Anthropic.
 *
 * Anthropic answers requests that carry an `Origin` with:
 *
 *     CORS requests are not allowed for this Organization because of its
 *     settings.
 *
 * This is a platform difference, not a policy one — the same extension is
 * accepted in Chrome. A Chromium extension holding `host_permissions` for a
 * host issues requests to it as same-origin and sends no `Origin` at all;
 * Firefox grants the same CORS exemption but still stamps
 * `Origin: moz-extension://<uuid>` on the request. The server sees that header
 * and takes the request for a browser-side CORS call.
 *
 * Removing it restores what Chrome sends. Nothing is substituted in its place:
 * the extension is not claiming to be a Chrome extension or any other origin,
 * and authentication is unchanged — the OAuth token still travels in the
 * request and still has to be valid.
 *
 * Scope is deliberately narrow. Only requests whose initiator is this
 * extension's own pages are touched, and only towards Anthropic's hosts.
 * Stripping `Origin` from page requests would strip a header servers rely on
 * for CSRF defence, so `isOwnRequest` is the load-bearing check here.
 */

const { NATIVE, log, warn } = globalThis.__ffPort;

const HTTP_ENDPOINTS = [
  'https://api.anthropic.com/*',
  'https://claude.ai/*',
  'https://*.claude.ai/*',
  'https://platform.claude.com/*',
];

const WEBSOCKET_ENDPOINTS = [
  'wss://bridge.claudeusercontent.com/*',
  'wss://bridge-staging.claudeusercontent.com/*',
];

const EXTENSION_BASE = NATIVE.runtime.getURL('');

/**
 * True only when this extension issued the request. Firefox normally reports
 * the initiating document in `originUrl`; for background and side-panel fetches
 * that is a moz-extension:// URL under our own base.
 *
 * Some extension-initiated requests arrive with neither `originUrl` nor
 * `documentUrl` set. Those are still safe to treat as ours: this listener only
 * ever sees Anthropic's hosts, and a request with no tab did not come from a
 * page. Anything that *does* carry an initiator is judged on it, so a request
 * from a claude.ai tab keeps its Origin.
 */
function isOwnRequest(details) {
  const initiator = details.originUrl ?? details.documentUrl;
  if (typeof initiator === 'string') return initiator.startsWith(EXTENSION_BASE);
  return details.tabId === undefined || details.tabId < 0;
}

let announced = false;

function stripOrigin(details) {
  if (!isOwnRequest(details)) return {};

  const headers = details.requestHeaders ?? [];
  const kept = headers.filter((header) => header.name.toLowerCase() !== 'origin');
  if (kept.length === headers.length) return {};

  if (!announced) {
    announced = true;
    console.info('[ff-port] stripping Origin from this extension\'s requests to Anthropic');
  }
  log('stripped Origin from', details.url);
  return { requestHeaders: kept };
}

function listen(urls, label) {
  try {
    NATIVE.webRequest.onBeforeSendHeaders.addListener(stripOrigin, { urls }, [
      'blocking',
      'requestHeaders',
    ]);
    return true;
  } catch (error) {
    // Older Firefox rejects ws:/wss: match patterns in a webRequest filter, and
    // a build without blocking webRequest rejects the 'blocking' option.
    warn(`could not watch ${label} requests`, error);
    return false;
  }
}

if (!NATIVE.webRequest?.onBeforeSendHeaders) {
  warn('webRequest is unavailable; requests to Anthropic will keep their Origin header');
} else {
  const http = listen(HTTP_ENDPOINTS, 'HTTP');
  const websocket = listen(WEBSOCKET_ENDPOINTS, 'WebSocket');
  // Printed once at startup: if the CORS rejection persists, the first thing
  // to know is whether this listener is attached at all.
  console.info(
    `[ff-port] Origin stripping armed — HTTP: ${http ? 'yes' : 'NO'}, ` +
      `WebSocket: ${websocket ? 'yes' : 'NO'}`,
  );
}
