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
