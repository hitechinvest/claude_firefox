/**
 * `chrome.debugger` — a CDP subset rebuilt on ordinary WebExtension APIs.
 *
 * Firefox has no debugger API and no way for an extension to speak the Chrome
 * DevTools Protocol, so this is the one part of the port that is an emulation
 * rather than a rename.  The extension only uses a narrow slice of CDP, and
 * every method in it has a reasonable Firefox counterpart:
 *
 *   Page.captureScreenshot     -> tabs.captureTab / tabs.captureVisibleTab
 *   Page.navigate / reload     -> tabs.update / tabs.reload
 *   Page.frameNavigated        -> webNavigation.onCommitted
 *   Page.handleJavaScriptDialog-> MAIN-world dialog interception (ff-content)
 *   Input.dispatch*            -> synthetic events from the content agent
 *   Runtime.evaluate           -> scripting.executeScript in the MAIN world
 *   Runtime.consoleAPICalled   -> MAIN-world console hooks
 *   Network.*                  -> webRequest
 *
 * The differences that survive are listed in README.md; the important one is
 * that synthesised input carries `isTrusted === false`.
 */

const {
  NATIVE,
  registerNamespace,
  invokeCallback,
  makeEvent,
  log,
  warn,
} = globalThis.__ffPort;

const AGENT_FILES = ['ff-content/cdp-agent.js'];
const MAIN_FILES = ['ff-content/cdp-main.js'];

/** tabId -> {version, domains:Set<string>} */
const sessions = new Map();

const onEvent = makeEvent('debugger.onEvent');
const onDetach = makeEvent('debugger.onDetach');

function requireSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
  }
  return session;
}

function emit(tabId, method, params) {
  if (!sessions.has(tabId)) return;
  onEvent.dispatch({ tabId }, method, params);
}

function domainEnabled(tabId, domain) {
  return sessions.get(tabId)?.domains.has(domain) ?? false;
}

// ---------------------------------------------------------------------------
// talking to the content-script half
// ---------------------------------------------------------------------------

function callAgent(tabId, method, params, options = { frameId: 0 }) {
  return NATIVE.tabs.sendMessage(
    tabId,
    { __ffCdp: 'command', method, params },
    options,
  );
}

/**
 * The page-world hooks (dialog interception, console forwarding) stay inert
 * until the corresponding CDP domain is enabled, so pages that the extension is
 * not driving keep their normal behaviour.  Broadcast to every frame.
 */
function configureAgent(tabId) {
  return callAgent(
    tabId,
    'Agent.configure',
    {
      interceptDialogs: domainEnabled(tabId, 'Page'),
      forwardConsole: domainEnabled(tabId, 'Runtime'),
    },
    {},
  ).catch(() => {
    /* no content script in this tab yet; Page.enable will retry on re-attach */
  });
}

async function ensureAgent(tabId) {
  try {
    await callAgent(tabId, 'Agent.ping', {});
    return;
  } catch {
    // No content script yet — the tab predates the install, or the declared
    // script has not run on this document.
  }
  await NATIVE.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: MAIN_FILES,
    world: 'MAIN',
    injectImmediately: true,
  });
  await NATIVE.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: AGENT_FILES,
    injectImmediately: true,
  });
}

// ---------------------------------------------------------------------------
// command implementations
// ---------------------------------------------------------------------------

const CDP_IMAGE_FORMATS = { png: 'png', jpeg: 'jpeg', webp: 'png' };

async function captureScreenshot(tabId, params = {}) {
  const options = { format: CDP_IMAGE_FORMATS[params.format] || 'png' };
  if (options.format === 'jpeg' && typeof params.quality === 'number') {
    options.quality = params.quality;
  }
  if (params.clip) {
    const { x = 0, y = 0, width, height, scale } = params.clip;
    options.rect = { x, y, width, height };
    if (typeof scale === 'number' && scale > 0) options.scale = scale;
  }

  let dataUrl;
  if (typeof NATIVE.tabs.captureTab === 'function') {
    dataUrl = await NATIVE.tabs.captureTab(tabId, options);
  } else {
    const tab = await NATIVE.tabs.get(tabId);
    dataUrl = await NATIVE.tabs.captureVisibleTab(tab.windowId, options);
  }

  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('screenshot capture returned no image data');
  return { data: dataUrl.slice(comma + 1) };
}

async function runtimeEvaluate(tabId, params = {}) {
  const { expression, returnByValue = true, awaitPromise = false } = params;

  const [injection] = await NATIVE.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    injectImmediately: true,
    args: [expression, awaitPromise],
    func: async (source, shouldAwait) => {
      try {
        // Indirect eval so the expression sees the global scope, matching
        // CDP.  Subject to the page's own CSP.
        let value = (0, eval)(source);
        if (shouldAwait) value = await value;
        const type = value === null ? 'object' : typeof value;
        let serialisable = value;
        try {
          serialisable = JSON.parse(JSON.stringify(value ?? null));
        } catch {
          serialisable = String(value);
        }
        return { ok: true, type, value: serialisable, description: String(value) };
      } catch (error) {
        return {
          ok: false,
          text: String(error && error.message ? error.message : error),
          stack: error && error.stack ? String(error.stack) : undefined,
        };
      }
    },
  });

  const result = injection?.result;
  if (!result) throw new Error('Runtime.evaluate produced no result');
  if (!result.ok) {
    return {
      result: { type: 'object', subtype: 'error', description: result.text },
      exceptionDetails: {
        exceptionId: 0,
        text: result.text,
        lineNumber: 0,
        columnNumber: 0,
        exception: { type: 'object', subtype: 'error', description: result.stack },
      },
    };
  }
  return {
    result: returnByValue
      ? { type: result.type, value: result.value }
      : { type: result.type, description: result.description },
  };
}

async function setDomain(tabId, domain, enabled) {
  const { domains } = requireSession(tabId);
  if (enabled) domains.add(domain);
  else domains.delete(domain);
  if (domain === 'Page' || domain === 'Runtime') await configureAgent(tabId);
  return {};
}

const COMMANDS = {
  'Page.enable': (tabId) => setDomain(tabId, 'Page', true),
  'Page.disable': (tabId) => setDomain(tabId, 'Page', false),
  'Runtime.enable': (tabId) => setDomain(tabId, 'Runtime', true),
  'Runtime.disable': (tabId) => setDomain(tabId, 'Runtime', false),
  'Network.enable': (tabId) => setDomain(tabId, 'Network', true),
  'Network.disable': (tabId) => setDomain(tabId, 'Network', false),
  'DOM.enable': (tabId) => setDomain(tabId, 'DOM', true),
  'DOM.disable': (tabId) => setDomain(tabId, 'DOM', false),

  'Page.captureScreenshot': captureScreenshot,
  'Runtime.evaluate': runtimeEvaluate,

  'Page.navigate': async (tabId, params) => {
    await NATIVE.tabs.update(tabId, { url: params.url });
    return { frameId: '0' };
  },
  'Page.reload': async (tabId, params) => {
    await NATIVE.tabs.reload(tabId, { bypassCache: Boolean(params?.ignoreCache) });
    return {};
  },
  'Page.bringToFront': async (tabId) => {
    await NATIVE.tabs.update(tabId, { active: true });
    return {};
  },

  // Emulation has no WebExtension equivalent; the extension treats these as
  // best-effort, so report success rather than failing a whole action.
  'Emulation.setDeviceMetricsOverride': async () => ({}),
  'Emulation.clearDeviceMetricsOverride': async () => ({}),
};

// Everything below is handled inside the page by ff-content/cdp-agent.js.
const AGENT_COMMANDS = new Set([
  'Page.handleJavaScriptDialog',
  'Page.getLayoutMetrics',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Input.synthesizeScrollGesture',
]);

async function dispatchCommand(tabId, method, params) {
  const handler = COMMANDS[method];
  if (handler) return (await handler(tabId, params)) ?? {};
  if (AGENT_COMMANDS.has(method)) {
    return (await callAgent(tabId, method, params)) ?? {};
  }
  throw new Error(`'${method}' is not supported by the Firefox CDP shim`);
}

// ---------------------------------------------------------------------------
// chrome.debugger surface
// ---------------------------------------------------------------------------

function tabIdOf(target) {
  const tabId = target?.tabId;
  if (typeof tabId !== 'number') {
    throw new Error('the Firefox CDP shim only supports {tabId} targets');
  }
  return tabId;
}

function detachInternal(tabId, reason) {
  if (!sessions.delete(tabId)) return;
  onDetach.dispatch({ tabId }, reason);
}

const debuggerShim = {
  attach(target, requiredVersion, callback) {
    (async () => {
      const tabId = tabIdOf(target);
      if (sessions.has(tabId)) {
        throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      }
      sessions.set(tabId, { version: requiredVersion, domains: new Set() });
      try {
        await ensureAgent(tabId);
      } catch (err) {
        sessions.delete(tabId);
        throw err;
      }
      log('attached', tabId);
    })().then(
      () => invokeCallback(callback, [], null),
      (err) => invokeCallback(callback, [], err),
    );
  },

  detach(target, callback) {
    try {
      detachInternal(tabIdOf(target), 'canceled_by_user');
      invokeCallback(callback, [], null);
    } catch (err) {
      invokeCallback(callback, [], err);
    }
  },

  getTargets(callback) {
    NATIVE.tabs
      .query({})
      .then((tabs) =>
        tabs.map((tab) => ({
          id: String(tab.id),
          type: 'page',
          title: tab.title ?? '',
          url: tab.url ?? '',
          attached: sessions.has(tab.id),
          tabId: tab.id,
        })),
      )
      .then(
        (targets) => invokeCallback(callback, [targets], null),
        (err) => invokeCallback(callback, [[]], err),
      );
  },

  sendCommand(target, method, commandParams, callback) {
    // Chrome allows sendCommand(target, method, callback).
    if (typeof commandParams === 'function') {
      callback = commandParams;
      commandParams = undefined;
    }
    (async () => {
      const tabId = tabIdOf(target);
      requireSession(tabId);
      return dispatchCommand(tabId, method, commandParams ?? {});
    })().then(
      (result) => invokeCallback(callback, [result], null),
      (err) => {
        log('sendCommand failed', method, err);
        invokeCallback(callback, [undefined], err);
      },
    );
  },

  onEvent,
  onDetach,
};

registerNamespace('debugger', debuggerShim);

// ---------------------------------------------------------------------------
// event sources
// ---------------------------------------------------------------------------

NATIVE.tabs.onRemoved.addListener((tabId) => detachInternal(tabId, 'target_closed'));

NATIVE.webNavigation.onCommitted.addListener((details) => {
  if (!sessions.has(details.tabId)) return;
  // The new document gets a fresh (inert) copy of the page-world hooks.
  if (details.frameId === 0) configureAgent(details.tabId);
  if (!domainEnabled(details.tabId, 'Page')) return;
  const frame = {
    id: String(details.frameId),
    url: details.url,
    loaderId: `${details.tabId}:${details.frameId}`,
    securityOrigin: (() => {
      try {
        return new URL(details.url).origin;
      } catch {
        return '';
      }
    })(),
    mimeType: 'text/html',
  };
  // The extension keys "did the top frame navigate?" off the absence of
  // parentId, so only sub-frames get one.
  if (details.parentFrameId >= 0) frame.parentId = String(details.parentFrameId);
  emit(details.tabId, 'Page.frameNavigated', { frame, type: 'Navigation' });
});

NATIVE.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  emit(details.tabId, 'Page.loadEventFired', { timestamp: Date.now() / 1000 });
});

const RESOURCE_TYPES = {
  main_frame: 'Document',
  sub_frame: 'Document',
  stylesheet: 'Stylesheet',
  script: 'Script',
  image: 'Image',
  imageset: 'Image',
  font: 'Font',
  object: 'Other',
  xmlhttprequest: 'XHR',
  fetch: 'Fetch',
  ping: 'Ping',
  csp_report: 'CSPViolationReport',
  media: 'Media',
  websocket: 'WebSocket',
  other: 'Other',
};

const NETWORK_FILTER = { urls: ['<all_urls>'] };

function networkEnabledFor(details) {
  return details.tabId >= 0 && domainEnabled(details.tabId, 'Network');
}

NATIVE.webRequest.onBeforeRequest.addListener((details) => {
  if (!networkEnabledFor(details)) return;
  emit(details.tabId, 'Network.requestWillBeSent', {
    requestId: String(details.requestId),
    loaderId: `${details.tabId}:${details.frameId}`,
    documentURL: details.documentUrl ?? details.url,
    request: { url: details.url, method: details.method },
    timestamp: details.timeStamp / 1000,
    wallTime: details.timeStamp / 1000,
    type: RESOURCE_TYPES[details.type] ?? 'Other',
    frameId: String(details.frameId),
  });
}, NETWORK_FILTER);

NATIVE.webRequest.onHeadersReceived.addListener((details) => {
  if (!networkEnabledFor(details)) return;
  const headers = {};
  let mimeType = '';
  for (const header of details.responseHeaders ?? []) {
    headers[header.name] = header.value ?? '';
    if (header.name.toLowerCase() === 'content-type') {
      mimeType = (header.value ?? '').split(';')[0].trim();
    }
  }
  emit(details.tabId, 'Network.responseReceived', {
    requestId: String(details.requestId),
    loaderId: `${details.tabId}:${details.frameId}`,
    timestamp: details.timeStamp / 1000,
    type: RESOURCE_TYPES[details.type] ?? 'Other',
    response: {
      url: details.url,
      status: details.statusCode,
      statusText: details.statusLine ?? '',
      headers,
      mimeType,
    },
    frameId: String(details.frameId),
  });
}, NETWORK_FILTER, ['responseHeaders']);

NATIVE.webRequest.onErrorOccurred.addListener((details) => {
  if (!networkEnabledFor(details)) return;
  emit(details.tabId, 'Network.loadingFailed', {
    requestId: String(details.requestId),
    timestamp: details.timeStamp / 1000,
    type: RESOURCE_TYPES[details.type] ?? 'Other',
    errorText: details.error ?? 'net::ERR_FAILED',
    canceled: details.error === 'NS_BINDING_ABORTED',
  });
}, NETWORK_FILTER);

/** Events the page-side agent raises: dialogs, console output, exceptions. */
NATIVE.runtime.onMessage.addListener((message, sender) => {
  if (message?.__ffCdp !== 'event') return undefined;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return undefined;

  const domain = String(message.method).split('.')[0];
  if (!domainEnabled(tabId, domain)) return undefined;

  emit(tabId, message.method, message.params ?? {});
  return undefined;
});

if (!NATIVE.webRequest) {
  warn('webRequest unavailable; Network.* CDP events will not be emitted');
}
