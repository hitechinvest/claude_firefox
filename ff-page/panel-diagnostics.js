/**
 * Turns a blank side panel into a readable report.
 *
 * `sidepanel.html` is a minified React bundle: when it throws during startup,
 * or waits forever on a background message that never gets answered, the only
 * symptom is an empty `#root`.  Reading that requires the Browser Toolbox and
 * knowing which context to pick.
 *
 * This runs as a classic script ahead of the module bundle (modules are
 * deferred), so its handlers are installed before anything else executes.  If
 * `#root` is still empty after the grace period, it renders what it collected:
 * errors, background messages that never came back, and which of the shimmed
 * APIs are actually reachable from this context.
 *
 * It never touches the page unless the panel failed to render.
 */

(() => {
  'use strict';

  const GRACE_MS = 5000;
  // The bundle is Chrome code and calls `chrome`, not `browser`; instrumenting
  // the other one would see nothing.
  const api = globalThis.chrome ?? globalThis.browser;

  const errors = [];
  const pendingMessages = new Map();
  let nextMessageId = 1;

  function record(kind, detail) {
    errors.push({ kind, detail: String(detail), at: Date.now() });
  }

  window.addEventListener(
    'error',
    (event) => {
      const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : '';
      record('error', `${event.message}${where}`);
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    record('unhandledrejection', reason?.stack ?? reason?.message ?? reason);
  });

  const originalConsoleError = console.error;
  console.error = function (...args) {
    record('console.error', args.map((a) => a?.stack ?? a).join(' '));
    return originalConsoleError.apply(this, args);
  };

  // A panel that renders nothing without a crash is usually blocked on the
  // background, so track which messages never came back.
  try {
    const originalSendMessage = api.runtime.sendMessage.bind(api.runtime);
    api.runtime.sendMessage = function (...args) {
      const id = nextMessageId++;
      const payload = args.find((a) => a && typeof a === 'object') ?? args[0];
      pendingMessages.set(id, { payload, sentAt: Date.now() });
      let result;
      try {
        result = originalSendMessage(...args);
      } catch (error) {
        pendingMessages.delete(id);
        throw error;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            pendingMessages.delete(id);
            return value;
          },
          (error) => {
            pendingMessages.delete(id);
            record('sendMessage rejected', `${describe(payload)} -> ${error?.message ?? error}`);
            throw error;
          },
        );
      }
      pendingMessages.delete(id);
      return result;
    };
  } catch (error) {
    record('diagnostics', `could not instrument runtime.sendMessage: ${error?.message ?? error}`);
  }

  function describe(value) {
    try {
      const json = JSON.stringify(value);
      return json && json.length > 200 ? `${json.slice(0, 200)}…` : json ?? String(value);
    } catch {
      return String(value);
    }
  }

  function apiAvailability() {
    const names = [
      'sidePanel',
      'debugger',
      'offscreen',
      'tabGroups',
      'declarativeNetRequest',
      'scripting',
      'tabs',
    ];
    const chrome = globalThis.chrome ?? {};
    const parts = names.map((name) => `${name}=${chrome[name] ? 'yes' : 'NO'}`);
    parts.push(`runtime.getContexts=${chrome.runtime?.getContexts ? 'yes' : 'NO'}`);
    parts.push(`runtime.ContextType=${chrome.runtime?.ContextType ? 'yes' : 'NO'}`);
    return parts.join('  ');
  }

  function section(title, lines) {
    if (!lines.length) return '';
    return `\n${title}\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
  }

  function report() {
    const now = Date.now();
    const tabId = new URLSearchParams(location.search).get('tabId');

    const context = [
      `url        ${location.href}`,
      `tabId      ${tabId ?? 'MISSING — the panel needs one'}`,
      `userAgent  ${navigator.userAgent}`,
      `api        ${apiAvailability()}`,
    ];

    const stuck = [...pendingMessages.values()].map(
      (entry) => `${describe(entry.payload)} — no reply after ${((now - entry.sentAt) / 1000).toFixed(1)}s`,
    );

    const failures = errors.map((entry) => `[${entry.kind}] ${entry.detail}`);

    return (
      'Claude (Firefox port): the panel did not render.\n' +
      section('context', context) +
      section(`errors (${failures.length})`, failures) +
      section(`background messages with no reply (${stuck.length})`, stuck) +
      (failures.length || stuck.length
        ? ''
        : '\nNothing was caught — the bundle is most likely waiting on something\n' +
          'that never resolves. Check the background page console.\n')
    );
  }

  function show() {
    const root = document.getElementById('root');
    if (root && root.childElementCount > 0) return; // the panel rendered fine

    const text = report();
    console.warn(text);

    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText =
      'margin:0;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'white-space:pre-wrap;word-break:break-word;color:#1f1f1f;background:#faf9f5;' +
      'height:100vh;box-sizing:border-box;overflow:auto';
    (root ?? document.body).appendChild(pre);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(show, GRACE_MS));
  } else {
    setTimeout(show, GRACE_MS);
  }
})();
