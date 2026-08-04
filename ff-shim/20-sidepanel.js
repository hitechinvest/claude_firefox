/**
 * `chrome.sidePanel` on top of Firefox's `sidebarAction`.
 *
 * The two APIs line up better than they look: Chrome's per-tab side panel path
 * maps onto `sidebarAction.setPanel({tabId, panel})`, and the extension already
 * encodes the tab it belongs to in the panel URL (`sidepanel.html?tabId=N`).
 *
 * The one thing that does not map is timing.  `sidebarAction.open()` only works
 * from inside a user-input handler, and it stops counting as one after the first
 * `await`.  So:
 *
 *   - `open()` calls straight through, synchronously, and is safe to call from
 *     the extension's `action.onClicked` handler (which reaches it before any
 *     await).
 *   - the `toggle-side-panel` command reaches `open()` only after a
 *     `tabs.query` callback, by which point the gesture is gone.  We register
 *     our own listener here — shims load first, so ours runs first — and toggle
 *     the sidebar while the gesture is still valid.
 */

const { NATIVE, registerNamespace, callbackable, log, warn } = globalThis.__ffPort;

const SIDEPANEL_COMMAND = 'toggle-side-panel';
/** How long after a shim-driven toggle we ignore the extension's own open(). */
const TOGGLE_GRACE_MS = 1500;

const optionsByTab = new Map();
let lastToggleAt = 0;
/** Which tab the sidebar is currently showing, so it is not reloaded onto itself. */
let currentPanelTabId;

function panelUrl(path) {
  return path ? NATIVE.runtime.getURL(path) : null;
}

function setPanel(details) {
  return NATIVE.sidebarAction.setPanel(details).catch((err) => {
    warn('sidebarAction.setPanel failed', err);
  });
}

const sidePanel = {
  setOptions: callbackable(async (options = {}) => {
    const { tabId, path, enabled } = options;
    const url = enabled === false ? null : panelUrl(path);

    if (typeof tabId === 'number') {
      optionsByTab.set(tabId, { ...options });
      // The extension is pointing the panel at this tab itself; record it so
      // the active-tab follower below does not immediately reload on top.
      if (enabled !== false) currentPanelTabId = tabId;
      // Deliberately not awaited: callers run setOptions() and open()
      // back to back and the second must stay inside the user gesture.
      setPanel({ tabId, panel: url });
    } else {
      setPanel({ panel: url });
    }
  }),

  getOptions: callbackable(async (options = {}) => {
    const { tabId } = options;
    if (typeof tabId === 'number' && optionsByTab.has(tabId)) {
      return optionsByTab.get(tabId);
    }
    const panel = await NATIVE.sidebarAction.getPanel(
      typeof tabId === 'number' ? { tabId } : {},
    );
    return { tabId, path: panel, enabled: Boolean(panel) };
  }),

  /**
   * Not wrapped in `callbackable`: the await inside it would spend the user
   * gesture before `sidebarAction.open()` ever ran.
   */
  open(options = {}, callback) {
    if (Date.now() - lastToggleAt < TOGGLE_GRACE_MS) {
      // A keyboard toggle just handled this; re-opening would undo a close.
      log('sidePanel.open() suppressed, toggle in flight');
      const settled = Promise.resolve();
      if (callback) settled.then(() => callback());
      return settled;
    }

    const promise = NATIVE.sidebarAction.open().catch((err) => {
      warn(
        'sidebarAction.open() failed — Firefox only allows it directly from a ' +
          'user input handler',
        err,
      );
      throw err;
    });
    if (callback) promise.then(() => callback()).catch(() => callback());
    return promise;
  },

  /** Chrome-only ergonomics; Firefox always opens the sidebar on action click. */
  setPanelBehavior: callbackable(async () => undefined),
  getPanelBehavior: callbackable(async () => ({ openPanelOnActionClick: true })),
};

registerNamespace('sidePanel', sidePanel);

// Keep the per-tab bookkeeping from leaking.
NATIVE.tabs.onRemoved.addListener((tabId) => optionsByTab.delete(tabId));

// Runs before the extension's own handler, while the keypress still counts as
// user input.
NATIVE.commands.onCommand.addListener((command) => {
  if (command !== SIDEPANEL_COMMAND) return;
  lastToggleAt = Date.now();
  NATIVE.sidebarAction.toggle().catch((err) => {
    warn('sidebarAction.toggle() failed', err);
  });
});

// ---------------------------------------------------------------------------
// following the active tab
// ---------------------------------------------------------------------------

/**
 * Chrome's side panel is per tab: each one gets its own panel document, so each
 * one keeps its own conversation.  A Firefox sidebar is one document per
 * *window*, and switching tabs does not reload it — so without this the same
 * conversation, bound to whichever tab happened to open it, shows on every tab.
 *
 * The bundle reads its tab from `?tabId=` once at startup and never re-reads
 * it, so the only way to retarget the panel is to point the sidebar at a new
 * URL, which reloads it.  That reload is the cost of per-tab conversations
 * here; the extension restores the right conversation from the tab id.
 *
 * Set `ffPortSidebarFollowsTab` to false in extension storage to keep a single
 * shared panel instead:
 *
 *     browser.storage.local.set({ffPortSidebarFollowsTab: false})
 */
const FOLLOW_PREF = 'ffPortSidebarFollowsTab';
const RETARGET_DEBOUNCE_MS = 150;

let followActiveTab = true;
NATIVE.storage?.local
  ?.get(FOLLOW_PREF)
  .then((stored) => {
    if (stored && stored[FOLLOW_PREF] === false) followActiveTab = false;
  })
  .catch(() => {});

NATIVE.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && FOLLOW_PREF in changes) {
    followActiveTab = changes[FOLLOW_PREF].newValue !== false;
  }
});

let retargetTimer;

async function retargetSidebar(tabId) {
  if (!followActiveTab || tabId === currentPanelTabId) return;

  // Reloading a sidebar nobody is looking at would be pure waste.
  try {
    if (!(await NATIVE.sidebarAction.isOpen({}))) return;
  } catch {
    return;
  }

  currentPanelTabId = tabId;
  const panel = panelUrl(`sidepanel.html?tabId=${encodeURIComponent(tabId)}`);
  // Global rather than per-tab: a per-tab panel only applies while that tab is
  // active, and the extension sets those itself when it opens the panel.
  await setPanel({ panel });
  log('sidebar retargeted to tab', tabId);
}

NATIVE.tabs.onActivated.addListener(({ tabId }) => {
  clearTimeout(retargetTimer);
  // Debounced: flicking through tabs should not reload the bundle each time.
  retargetTimer = setTimeout(() => retargetSidebar(tabId), RETARGET_DEBOUNCE_MS);
});
