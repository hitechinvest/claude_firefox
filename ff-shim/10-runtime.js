/**
 * `chrome.runtime` members Firefox does not implement.
 *
 * The extension uses `chrome.runtime.getContexts({contextTypes: [SIDE_PANEL]})`
 * to find out whether its side panel is already open for a given tab, and reads
 * `documentUrl` off the result to compare the `?tabId=` query parameter.
 * Firefox has `runtime.getContexts` (127+) but no `runtime.ContextType`, and it
 * reports the sidebar under its own name, so both are normalised here.
 */

const { NATIVE, registerRuntimeMember, callbackable, log } = globalThis.__ffPort;

const ContextType = {
  TAB: 'TAB',
  POPUP: 'POPUP',
  BACKGROUND: 'BACKGROUND',
  OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
  SIDE_PANEL: 'SIDE_PANEL',
  DEVELOPER_TOOLS: 'DEVELOPER_TOOLS',
};

registerRuntimeMember('ContextType', ContextType);

const SIDEPANEL_PATH = 'sidepanel.html';

function isSidePanelUrl(url) {
  return typeof url === 'string' && url.includes(SIDEPANEL_PATH);
}

/** Firefox names the sidebar differently across versions; fold them together. */
function normaliseContextType(context) {
  if (isSidePanelUrl(context.documentUrl)) return ContextType.SIDE_PANEL;
  const raw = String(context.contextType || '').toUpperCase();
  if (raw === 'SIDEBAR' || raw === 'SIDE_PANEL') return ContextType.SIDE_PANEL;
  return raw || ContextType.TAB;
}

/**
 * Fallback for Firefox builds whose `getContexts` rejects unknown context
 * types: enumerate the extension's own views instead.
 */
function contextsFromViews() {
  const views = NATIVE.extension?.getViews?.() ?? [];
  const contexts = [];
  for (const view of views) {
    let href;
    try {
      href = view.location.href;
    } catch {
      continue; // view was torn down mid-enumeration
    }
    contexts.push({
      contextId: href,
      contextType: isSidePanelUrl(href)
        ? ContextType.SIDE_PANEL
        : ContextType.TAB,
      documentUrl: href,
      documentOrigin: new URL(href).origin,
      frameId: 0,
      tabId: -1,
      windowId: -1,
      incognito: false,
    });
  }
  return contexts;
}

const getContexts = callbackable(async (filter) => {
  let contexts;
  try {
    // Ask for everything and filter locally: Firefox's own contextTypes enum
    // does not line up with Chrome's.
    contexts = await NATIVE.runtime.getContexts({});
  } catch (err) {
    log('getContexts unavailable, falling back to extension.getViews()', err);
    contexts = contextsFromViews();
  }

  contexts = contexts.map((context) => ({
    ...context,
    contextType: normaliseContextType(context),
  }));

  const wanted = filter?.contextTypes;
  if (Array.isArray(wanted) && wanted.length) {
    contexts = contexts.filter((c) => wanted.includes(c.contextType));
  }
  if (Array.isArray(filter?.documentUrls) && filter.documentUrls.length) {
    contexts = contexts.filter((c) => filter.documentUrls.includes(c.documentUrl));
  }
  if (Array.isArray(filter?.tabIds) && filter.tabIds.length) {
    contexts = contexts.filter((c) => filter.tabIds.includes(c.tabId));
  }
  return contexts;
});

registerRuntimeMember('getContexts', getContexts);
