/**
 * Background half of the local transcript.
 *
 * The recorder itself is shared with the panel — whichever context issues the
 * request is the one that can see it, and both do — so this only pulls it in
 * and adds a way to reach the viewer.
 *
 * The viewer lives at ff-page/transcript.html. Without an entry point that URL
 * is only reachable by typing the extension's UUID by hand, so it also goes on
 * the toolbar icon's context menu.
 */

import '../ff-page/transcript-recorder.js';

const { NATIVE, warn } = globalThis.__ffPort;

const MENU_ID = 'ff-port-transcript';
const VIEWER = 'ff-page/transcript.html';

function openViewer() {
  const url = NATIVE.runtime.getURL(VIEWER);
  NATIVE.tabs.query({ url }).then(
    (existing) => {
      // Reuse the tab if it is already open rather than piling up copies.
      if (existing.length) {
        NATIVE.tabs.update(existing[0].id, { active: true }).catch(() => {});
        return;
      }
      NATIVE.tabs.create({ url }).catch((error) => warn('could not open the viewer', error));
    },
    () => {
      NATIVE.tabs.create({ url }).catch(() => {});
    },
  );
}

const menus = NATIVE.menus ?? NATIVE.contextMenus;

if (menus?.create) {
  try {
    menus.removeAll?.(() => {});
  } catch {
    /* nothing registered yet */
  }
  try {
    menus.create({
      id: MENU_ID,
      title: 'Локальная история Claude',
      contexts: ['browser_action', 'action'],
    });
    menus.onClicked.addListener((info) => {
      if (info.menuItemId === MENU_ID) openViewer();
    });
  } catch (error) {
    warn('could not add the transcript menu item', error);
  }
} else {
  warn(`no menus API; open ${NATIVE.runtime.getURL(VIEWER)} directly`);
}
