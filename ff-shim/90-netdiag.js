/**
 * Log what actually leaves the browser when a request to Anthropic fails.
 *
 * The CORS rejection is answered by the server, not raised by Firefox, so the
 * only way to tell a header problem from a policy one is to look at the headers
 * that were on the wire *after* every listener had its turn — including
 * ff-shim/80-cors.js and the extension's own declarativeNetRequest rules.
 *
 * Only failures are logged (HTTP >= 400 and network errors), so this stays
 * quiet in normal use.  Credentials are masked: the point is which headers were
 * present, never their values.
 */

const { NATIVE, warn } = globalThis.__ffPort;

const WATCHED = [
  'https://api.anthropic.com/*',
  'https://claude.ai/*',
  'https://*.claude.ai/*',
  'https://platform.claude.com/*',
];

/** Never print these values — presence is all the diagnosis needs. */
const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'anthropic-auth-token',
  'proxy-authorization',
]);

const EXTENSION_BASE = NATIVE.runtime.getURL('');

/** requestId -> what we saw go out. */
const inFlight = new Map();
const MAX_TRACKED = 200;

function redact(headers = []) {
  return headers.map((header) =>
    SECRET_HEADERS.has(header.name.toLowerCase())
      ? `${header.name}: <redacted, ${String(header.value ?? '').length} chars>`
      : `${header.name}: ${header.value}`,
  );
}

function remember(details) {
  if (inFlight.size > MAX_TRACKED) inFlight.clear();
  inFlight.set(details.requestId, {
    url: details.url,
    method: details.method,
    type: details.type,
    initiator: details.originUrl ?? details.documentUrl ?? null,
    tabId: details.tabId,
    headers: redact(details.requestHeaders),
    fromExtension: String(details.originUrl ?? details.documentUrl ?? '').startsWith(
      EXTENSION_BASE,
    ),
  });
}

function reportFailure(details, outcome) {
  const sent = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  if (!sent) return;

  const origin = sent.headers.find((line) => line.toLowerCase().startsWith('origin:'));
  console.warn(
    [
      `[ff-port] request to Anthropic failed: ${outcome}`,
      `  ${sent.method} ${sent.url}`,
      `  initiator      ${sent.initiator ?? '(none)'}`,
      `  from extension ${sent.fromExtension}`,
      `  tabId          ${sent.tabId}`,
      `  Origin header  ${origin ? `STILL PRESENT -> ${origin}` : 'absent (stripped as intended)'}`,
      '  headers sent:',
      ...sent.headers.map((line) => `    ${line}`),
    ].join('\n'),
  );
}

if (!NATIVE.webRequest?.onSendHeaders) {
  warn('webRequest unavailable; failed requests will not be explained');
} else {
  // onSendHeaders fires after every blocking listener and every DNR rule, so
  // this is the real set of headers.
  NATIVE.webRequest.onSendHeaders.addListener(remember, { urls: WATCHED }, ['requestHeaders']);

  NATIVE.webRequest.onCompleted.addListener(
    (details) => {
      if (details.statusCode >= 400) reportFailure(details, `HTTP ${details.statusCode}`);
      else inFlight.delete(details.requestId);
    },
    { urls: WATCHED },
  );

  NATIVE.webRequest.onErrorOccurred.addListener(
    (details) => reportFailure(details, details.error ?? 'network error'),
    { urls: WATCHED },
  );
}
