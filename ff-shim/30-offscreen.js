/**
 * `chrome.offscreen` on top of an iframe in the background page.
 *
 * Chrome needs the offscreen API because MV3 background contexts are service
 * workers with no DOM.  Firefox's MV3 background is an event *page*, so the
 * document the extension is asking for is already there — the offscreen
 * document just becomes a hidden iframe inside it.
 *
 * `offscreen.html` talks to the background over `runtime.sendMessage`, which
 * works unchanged from an iframe of an extension page.
 */

const { NATIVE, registerNamespace, callbackable, warn } = globalThis.__ffPort;

const FRAME_ID = 'ff-port-offscreen';

const Reason = {
  TESTING: 'TESTING',
  AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
  IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
  DOM_SCRAPING: 'DOM_SCRAPING',
  BLOBS: 'BLOBS',
  DOM_PARSER: 'DOM_PARSER',
  USER_MEDIA: 'USER_MEDIA',
  DISPLAY_MEDIA: 'DISPLAY_MEDIA',
  WEB_RTC: 'WEB_RTC',
  CLIPBOARD: 'CLIPBOARD',
  LOCAL_STORAGE: 'LOCAL_STORAGE',
  WORKERS: 'WORKERS',
  BATTERY_STATUS: 'BATTERY_STATUS',
  MATCH_MEDIA: 'MATCH_MEDIA',
  GEOLOCATION: 'GEOLOCATION',
};

function hasDom() {
  return typeof document !== 'undefined' && Boolean(document.documentElement);
}

function existingFrame() {
  return hasDom() ? document.getElementById(FRAME_ID) : null;
}

const offscreen = {
  Reason,

  createDocument: callbackable(async ({ url } = {}) => {
    if (!hasDom()) {
      throw new Error('no DOM in this background context');
    }
    if (existingFrame()) {
      // Same error Chrome raises, so callers that rely on it still work.
      throw new Error('Only a single offscreen document may be created.');
    }
    if (!url) throw new Error('createDocument requires a url');

    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.src = NATIVE.runtime.getURL(url);
    frame.style.display = 'none';

    const loaded = new Promise((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener(
        'error',
        () => reject(new Error(`failed to load ${url}`)),
        { once: true },
      );
    });

    document.documentElement.appendChild(frame);
    await loaded;
  }),

  hasDocument: callbackable(async () => Boolean(existingFrame())),

  closeDocument: callbackable(async () => {
    const frame = existingFrame();
    if (!frame) throw new Error('No offscreen document to close.');
    frame.remove();
  }),
};

if (!hasDom()) {
  warn(
    'background context has no DOM; offscreen audio and GIF export will be ' +
      'unavailable',
  );
}

registerNamespace('offscreen', offscreen);
