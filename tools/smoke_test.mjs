/**
 * Behavioural tests for the shims in ff-shim/.
 *
 * Loads them into a mock WebExtension environment — the same order the ported
 * manifest lists them in — and drives the Chrome-shaped API the extension
 * bundle actually calls.  Catches the regressions that matter most here:
 * broken callback/lastError plumbing, commands that stop reaching their
 * Firefox counterpart, and events that stop being emitted.
 *
 *   node tools/smoke_test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const SHIMS = [
  '00-bootstrap.js',
  '10-runtime.js',
  '20-sidepanel.js',
  '30-offscreen.js',
  '40-debugger.js',
  '50-external.js',
  '60-dnr.js',
  '70-proxy-host.js',
  '80-cors.js',
];

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message ?? 'not equal'}: got ${a}, want ${e}`);
}

// ---------------------------------------------------------------------------
// mock WebExtension environment
// ---------------------------------------------------------------------------

function mockEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    async fire(...args) {
      const returned = [];
      for (const fn of [...listeners]) returned.push(await fn(...args));
      return returned;
    },
  };
}

function makeMockChrome() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve();
  };

  const contexts = [
    { contextType: 'BACKGROUND', documentUrl: 'moz-extension://test/_background.html' },
    { contextType: 'TAB', documentUrl: 'moz-extension://test/sidepanel.html?tabId=7' },
  ];

  const chrome = {
    calls,
    runtime: {
      id: 'claude-for-firefox@unofficial.port',
      lastError: undefined,
      getURL: (path) => `moz-extension://test/${path}`,
      getContexts: async () => contexts,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: mockEvent(),
      sendMessage: async (message) => {
        calls.push({ name: 'runtime.sendMessage', args: [message] });
      },
    },
    extension: { getViews: () => [] },
    storage: { local: { get: async () => ({}) } },
    tabs: {
      onRemoved: mockEvent(),
      query: async () => [{ id: 1, windowId: 10, title: 'Tab', url: 'https://example.com/' }],
      get: async (id) => ({ id, windowId: 10 }),
      update: record('tabs.update'),
      reload: record('tabs.reload'),
      captureTab: async (tabId, options) => {
        calls.push({ name: 'tabs.captureTab', args: [tabId, options] });
        return 'data:image/png;base64,AAAA';
      },
      sendMessage: async (tabId, message) => {
        calls.push({ name: 'tabs.sendMessage', args: [tabId, message] });
        return { ok: true };
      },
    },
    sidebarAction: {
      setPanel: record('sidebarAction.setPanel'),
      getPanel: async () => 'moz-extension://test/sidepanel.html',
      open: record('sidebarAction.open'),
      toggle: record('sidebarAction.toggle'),
    },
    commands: { onCommand: mockEvent() },
    webNavigation: { onCommitted: mockEvent(), onCompleted: mockEvent() },
    webRequest: {
      onBeforeRequest: mockEvent(),
      onHeadersReceived: mockEvent(),
      onErrorOccurred: mockEvent(),
      onBeforeSendHeaders: mockEvent(),
    },
    scripting: { executeScript: async () => [{ result: { ok: true, type: 'number', value: 4 } }] },
    declarativeNetRequest: {
      updateSessionRules: record('declarativeNetRequest.updateSessionRules'),
      // Firefox exposes this one natively; the shim must not shadow it.
      ResourceType: { XMLHTTPREQUEST: 'native-value' },
    },
  };
  return chrome;
}

/** Just enough DOM for the offscreen shim's hidden iframe. */
function makeMockDocument() {
  const children = [];
  const document = {
    children,
    createElement: () => ({
      style: {},
      listeners: {},
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      remove() {
        const i = children.indexOf(this);
        if (i >= 0) children.splice(i, 1);
      },
    }),
    getElementById: (id) => children.find((child) => child.id === id) ?? null,
  };
  document.documentElement = {
    appendChild(node) {
      children.push(node);
      // Firefox fires load asynchronously; the shim awaits it.
      setTimeout(() => node.listeners.load?.(), 0);
    },
  };
  return document;
}

function loadShims() {
  const native = makeMockChrome();
  // The vm context supplies the JS built-ins; these are the host bits the
  // shims reach for that a bare context does not have.
  const context = vm.createContext({
    chrome: native,
    document: makeMockDocument(),
    console,
    setTimeout,
    clearTimeout,
    URL,
  });

  for (const file of SHIMS) {
    const path = join(REPO, 'ff-shim', file);
    const source = readFileSync(path, 'utf8');
    // Firefox loads these as ES modules, so each one gets its own top-level
    // scope.  vm has no module loader here, so reproduce that with an IIFE —
    // without it the shared `const NATIVE` in every shim would collide.
    vm.runInContext(`(function(){'use strict';\n${source}\n})();`, context, { filename: path });
  }
  return { context, native, shimmed: context.chrome };
}

/** Promisify a Chrome-style callback API, capturing lastError. */
function callback(chrome, fn) {
  return new Promise((resolve) => {
    fn((...args) => resolve({ args, error: chrome.runtime.lastError }));
  });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

await test('missing namespaces are installed on chrome', () => {
  const { shimmed } = loadShims();
  assert(shimmed.sidePanel, 'chrome.sidePanel missing');
  assert(shimmed.debugger, 'chrome.debugger missing');
  assert(shimmed.offscreen, 'chrome.offscreen missing');
  assert(typeof shimmed.tabs.query === 'function', 'native namespaces still reachable');
});

await test('runtime.ContextType and getContexts normalise the sidebar', async () => {
  const { shimmed } = loadShims();
  assertEqual(shimmed.runtime.ContextType.SIDE_PANEL, 'SIDE_PANEL');
  const found = await shimmed.runtime.getContexts({
    contextTypes: [shimmed.runtime.ContextType.SIDE_PANEL],
  });
  assertEqual(found.length, 1, 'expected exactly one side panel context');
  assert(
    found[0].documentUrl.includes('tabId=7'),
    'documentUrl must survive so the extension can read ?tabId',
  );
});

await test('sidePanel.setOptions maps onto sidebarAction.setPanel', async () => {
  const { shimmed, native } = loadShims();
  await shimmed.sidePanel.setOptions({ tabId: 7, path: 'sidepanel.html?tabId=7', enabled: true });
  const call = native.calls.find((c) => c.name === 'sidebarAction.setPanel');
  assert(call, 'setPanel was never called');
  assertEqual(call.args[0].tabId, 7);
  assertEqual(call.args[0].panel, 'moz-extension://test/sidepanel.html?tabId=7');
});

await test('the toggle command reaches sidebarAction while the gesture is live', async () => {
  const { native } = loadShims();
  await native.commands.onCommand.fire('toggle-side-panel');
  assert(
    native.calls.some((c) => c.name === 'sidebarAction.toggle'),
    'toggle-side-panel did not reach sidebarAction.toggle',
  );
});

await test('debugger.attach reports success, double attach reports an error', async () => {
  const { shimmed } = loadShims();
  const first = await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  assert(!first.error, `first attach failed: ${first.error?.message}`);

  const second = await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  assert(second.error, 'second attach should have set runtime.lastError');
  assert(
    second.error.message.includes('already attached'),
    `unexpected error: ${second.error.message}`,
  );
});

await test('Page.captureScreenshot returns base64 from tabs.captureTab', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  const shot = await callback(shimmed, (cb) =>
    shimmed.debugger.sendCommand(
      { tabId: 1 },
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 80, clip: { x: 1, y: 2, width: 3, height: 4, scale: 2 } },
      cb,
    ),
  );
  assert(!shot.error, `sendCommand failed: ${shot.error?.message}`);
  assertEqual(shot.args[0], { data: 'AAAA' });

  const capture = native.calls.find((c) => c.name === 'tabs.captureTab');
  assertEqual(capture.args[1], {
    format: 'jpeg',
    quality: 80,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    scale: 2,
  });
});

await test('unsupported CDP methods surface as lastError, not silence', async () => {
  const { shimmed } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  const result = await callback(shimmed, (cb) =>
    shimmed.debugger.sendCommand({ tabId: 1 }, 'Tracing.start', {}, cb),
  );
  assert(result.error, 'expected an error for an unimplemented method');
  assert(
    result.error.message.includes('Tracing.start'),
    `error should name the method: ${result.error.message}`,
  );
});

await test('Input commands are forwarded to the page agent', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  await callback(shimmed, (cb) =>
    shimmed.debugger.sendCommand(
      { tabId: 1 },
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 },
      cb,
    ),
  );
  const forwarded = native.calls.find(
    (c) => c.name === 'tabs.sendMessage' && c.args[1].method === 'Input.dispatchMouseEvent',
  );
  assert(forwarded, 'Input.dispatchMouseEvent never reached the content agent');
  assertEqual(forwarded.args[1].params.x, 5);
});

await test('webNavigation.onCommitted becomes Page.frameNavigated', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  await callback(shimmed, (cb) => shimmed.debugger.sendCommand({ tabId: 1 }, 'Page.enable', {}, cb));

  const seen = [];
  shimmed.debugger.onEvent.addListener((source, method, params) =>
    seen.push({ source, method, params }),
  );

  await native.webNavigation.onCommitted.fire({
    tabId: 1,
    frameId: 0,
    parentFrameId: -1,
    url: 'https://example.com/page',
  });
  await native.webNavigation.onCommitted.fire({
    tabId: 1,
    frameId: 3,
    parentFrameId: 0,
    url: 'https://example.com/frame',
  });

  const [top, sub] = seen.filter((e) => e.method === 'Page.frameNavigated');
  assert(top, 'no Page.frameNavigated for the top frame');
  assert(
    top.params.frame.parentId === undefined,
    'the top frame must have no parentId — the extension keys off that',
  );
  assertEqual(sub.params.frame.parentId, '0', 'sub-frame should carry a parentId');
});

await test('Network events only flow once Network.enable is sent', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));

  const seen = [];
  shimmed.debugger.onEvent.addListener((source, method) => seen.push(method));

  const request = {
    tabId: 1,
    frameId: 0,
    requestId: '42',
    url: 'https://example.com/x.js',
    method: 'GET',
    type: 'script',
    timeStamp: 1000,
  };
  await native.webRequest.onBeforeRequest.fire(request);
  assertEqual(seen.length, 0, 'events leaked before Network.enable');

  await callback(shimmed, (cb) =>
    shimmed.debugger.sendCommand({ tabId: 1 }, 'Network.enable', {}, cb),
  );
  await native.webRequest.onBeforeRequest.fire(request);
  assert(seen.includes('Network.requestWillBeSent'), 'no Network.requestWillBeSent emitted');
});

await test('detach fires onDetach and stops the event stream', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  await callback(shimmed, (cb) => shimmed.debugger.sendCommand({ tabId: 1 }, 'Page.enable', {}, cb));

  const detaches = [];
  const events = [];
  shimmed.debugger.onDetach.addListener((source, reason) => detaches.push({ source, reason }));
  shimmed.debugger.onEvent.addListener((source, method) => events.push(method));

  await native.tabs.onRemoved.fire(1);
  assertEqual(detaches.length, 1, 'closing the tab should detach');
  assertEqual(detaches[0].reason, 'target_closed');

  await native.webNavigation.onCommitted.fire({
    tabId: 1,
    frameId: 0,
    parentFrameId: -1,
    url: 'https://example.com/',
  });
  assertEqual(events.length, 0, 'events kept flowing after detach');
});

await test('bridged claude.ai messages reach onMessageExternal', async () => {
  const { shimmed, native } = loadShims();

  const received = [];
  shimmed.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    received.push({ message, sender });
    sendResponse({ success: true, exists: true });
    return true;
  });

  const returned = await native.runtime.onMessage.fire(
    { __ffExternal: 'message', message: { type: 'ping' } },
    { url: 'https://claude.ai/chats', frameId: 0, tab: { id: 4 } },
  );
  // Other shims also listen on runtime.onMessage and ignore this envelope;
  // the responding listener is the one that answers with something.
  const reply = returned.find((value) => value !== undefined);

  assertEqual(received.length, 1, 'listener was not called');
  assertEqual(received[0].message, { type: 'ping' });
  assertEqual(
    received[0].sender.origin,
    'https://claude.ai',
    'the origin check in the extension depends on sender.origin',
  );
  assertEqual(await reply, { success: true, exists: true });
});

await test('a sender with no tab stays without one', async () => {
  const { shimmed, native } = loadShims();
  const seen = [];
  shimmed.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    seen.push(sender);
    sendResponse({});
    return true;
  });
  await native.runtime.onMessage.fire(
    { __ffExternal: 'message', message: { type: 'get_sidepanel_host_info' } },
    { url: 'https://claude.ai/', frameId: 0 },
  );
  assert('tab' in seen[0] === false, 'sender.tab must be absent for non-tab senders');
});

await test('offscreen documents become an iframe in the background page', async () => {
  const { shimmed, context } = loadShims();
  assertEqual(await shimmed.offscreen.hasDocument(), false, 'nothing should exist yet');

  await shimmed.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [shimmed.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'test',
  });
  assertEqual(context.document.children.length, 1, 'no iframe was appended');
  assertEqual(context.document.children[0].src, 'moz-extension://test/offscreen.html');
  assertEqual(await shimmed.offscreen.hasDocument(), true);

  let duplicateRejected = false;
  try {
    await shimmed.offscreen.createDocument({ url: 'offscreen.html' });
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, 'a second offscreen document should be rejected, as in Chrome');

  await shimmed.offscreen.closeDocument();
  assertEqual(context.document.children.length, 0, 'closeDocument left the iframe behind');
});

await test('declarativeNetRequest enums are filled in without shadowing natives', async () => {
  const { shimmed, native } = loadShims();
  const dnr = shimmed.declarativeNetRequest;

  // Reading these off `undefined` is what breaks the anthropic-client-* header
  // rules on Firefox.
  assertEqual(dnr.RuleActionType.MODIFY_HEADERS, 'modifyHeaders');
  assertEqual(dnr.HeaderOperation.SET, 'set');
  assertEqual(dnr.RuleActionType.BLOCK, 'block');

  assertEqual(
    dnr.ResourceType.XMLHTTPREQUEST,
    'native-value',
    'a member Firefox provides must not be overwritten by the shim',
  );

  await dnr.updateSessionRules({ addRules: [], removeRuleIds: [] });
  assert(
    native.calls.some((c) => c.name === 'declarativeNetRequest.updateSessionRules'),
    'native methods must stay callable through the shim proxy',
  );
});

await test('extension pages can reach the shims through the proxy host', async () => {
  const { native } = loadShims();

  const returned = await native.runtime.onMessage.fire(
    { __ffProxy: 'call', namespace: 'debugger', method: 'getTargets', args: [] },
    { url: 'moz-extension://test/sidepanel.html?tabId=1' },
  );
  // The other shims share runtime.onMessage and ignore this envelope.
  const response = returned.find((value) => value !== undefined);
  assert(response?.ok, `getTargets should succeed: ${response?.error}`);
  assert(Array.isArray(response.result), 'expected a target list');
});

await test('the proxy host refuses methods that are not on its allow-list', async () => {
  const { native } = loadShims();
  const returned = await native.runtime.onMessage.fire(
    { __ffProxy: 'call', namespace: 'tabs', method: 'remove', args: [1] },
    { url: 'moz-extension://test/sidepanel.html' },
  );
  const response = returned.find((r) => r !== undefined);
  assert(response && response.ok === false, 'an unlisted namespace must be rejected');
  assert(
    response.error.includes('not proxied'),
    `error should say why: ${response.error}`,
  );
});

await test('debugger events are broadcast to extension pages', async () => {
  const { shimmed, native } = loadShims();
  await callback(shimmed, (cb) => shimmed.debugger.attach({ tabId: 1 }, '1.3', cb));
  await callback(shimmed, (cb) => shimmed.debugger.sendCommand({ tabId: 1 }, 'Page.enable', {}, cb));

  await native.webNavigation.onCommitted.fire({
    tabId: 1,
    frameId: 0,
    parentFrameId: -1,
    url: 'https://example.com/',
  });

  const broadcast = native.calls.find(
    (c) => c.name === 'runtime.sendMessage' && c.args[0]?.__ffProxy === 'event',
  );
  assert(broadcast, 'no event was broadcast to extension pages');
  assertEqual(broadcast.args[0].namespace, 'debugger');
  assertEqual(broadcast.args[0].event, 'onEvent');
  assertEqual(broadcast.args[0].args[1], 'Page.frameNavigated');
});

await test('the Origin header is dropped from the extension\'s own requests', async () => {
  const { native } = loadShims();
  const returned = await native.webRequest.onBeforeSendHeaders.fire({
    url: 'https://api.anthropic.com/v1/messages',
    originUrl: 'moz-extension://test/_generated_background_page.html',
    requestHeaders: [
      { name: 'Origin', value: 'moz-extension://test' },
      { name: 'Authorization', value: 'Bearer token' },
    ],
  });
  const result = returned.find((r) => r?.requestHeaders);
  assert(result, 'the listener did not rewrite the headers');
  assertEqual(
    result.requestHeaders.map((h) => h.name),
    ['Authorization'],
    'only Origin should be removed',
  );
});

await test('page requests keep their Origin', async () => {
  const { native } = loadShims();
  // Stripping Origin from a page's request would remove a header servers use
  // for CSRF defence — this must never fire for anything but our own contexts.
  const returned = await native.webRequest.onBeforeSendHeaders.fire({
    url: 'https://api.anthropic.com/v1/messages',
    originUrl: 'https://evil.example/',
    requestHeaders: [{ name: 'Origin', value: 'https://evil.example' }],
  });
  assert(
    !returned.some((r) => r?.requestHeaders),
    'a web page request must be left untouched',
  );
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  console.log(`${result.ok ? '  ok  ' : '  FAIL'}  ${result.name}`);
  if (!result.ok) console.log(`        ${result.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
