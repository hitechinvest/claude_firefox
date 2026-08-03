/**
 * Entry point for the sidebar, so that sidepanel.html is never loaded without
 * the tab it belongs to.
 *
 * The panel reads its tab from its own query string:
 *
 *     new URLSearchParams(window.location.search).get('tabId')
 *
 * In Chrome that parameter is always there, because the only way the panel
 * opens is `sidePanel.setOptions({path: 'sidepanel.html?tabId=N'})` followed by
 * `sidePanel.open()`.  Firefox has a second route the extension never sees:
 * the user opening the sidebar from the browser's own sidebar button, which
 * loads `sidebar_action.default_panel` verbatim — no query string, no tab, and
 * a panel that renders nothing.
 *
 * So `default_panel` points here instead: resolve the active tab, then hand off
 * to the real panel.  `location.replace` keeps it out of session history.
 */

(async () => {
  const api = globalThis.browser ?? globalThis.chrome;

  let tabId;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch (error) {
    console.warn('[ff-port] could not resolve the active tab', error);
  }

  const target =
    typeof tabId === 'number'
      ? `/sidepanel.html?tabId=${encodeURIComponent(tabId)}`
      : '/sidepanel.html';

  location.replace(target);
})();
