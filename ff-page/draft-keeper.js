/**
 * Carry the unsent message across a panel reload.
 *
 * Retargeting the sidebar to a new tab reloads the panel document, which throws
 * away whatever was typed and not yet sent. Chrome never has to do that — its
 * side panel is per tab — so the bundle has no reason to preserve a draft, and
 * it does not.
 *
 * This keeps a copy: every keystroke in the composer is saved against the tab
 * the panel is showing, and put back when a panel for that tab loads with an
 * empty composer. Drafts are dropped once sent, and expire on their own so a
 * forgotten one does not resurface days later.
 *
 * Restoring has to go through the native value setter and an input event, or
 * React keeps its own state and overwrites the text on the next render.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'ffPortDrafts';
  const SAVE_DEBOUNCE_MS = 300;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const COMPOSER_SELECTOR =
    'textarea, [contenteditable="true"], [contenteditable=""], div[role="textbox"]';

  const api = globalThis.browser ?? globalThis.chrome;
  const tabId = new URLSearchParams(location.search).get('tabId');
  if (!tabId || !api?.storage?.local) return;

  let saveTimer;
  let restored = false;

  function readText(element) {
    if (!element) return '';
    return element.isContentEditable ? element.innerText : element.value ?? '';
  }

  /** React tracks the value it set; bypassing the setter makes it revert. */
  function writeText(element, text) {
    if (element.isContentEditable) {
      element.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.addRange(range);
      document.execCommand('insertText', false, text);
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set;
    if (setter) setter.call(element, text);
    else element.value = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }

  async function loadDrafts() {
    try {
      const stored = await api.storage.local.get(STORAGE_KEY);
      return stored?.[STORAGE_KEY] ?? {};
    } catch {
      return {};
    }
  }

  async function saveDraft(text) {
    const drafts = await loadDrafts();
    const now = Date.now();

    for (const [key, entry] of Object.entries(drafts)) {
      if (!entry?.savedAt || now - entry.savedAt > MAX_AGE_MS) delete drafts[key];
    }

    if (text.trim()) drafts[tabId] = { text, savedAt: now };
    else delete drafts[tabId];

    try {
      await api.storage.local.set({ [STORAGE_KEY]: drafts });
    } catch {
      /* quota or a teardown mid-write; the draft is best-effort */
    }
  }

  document.addEventListener(
    'input',
    (event) => {
      const element = event.target;
      if (!element?.matches?.(COMPOSER_SELECTOR)) return;
      restored = true; // the user is typing; do not overwrite them later
      clearTimeout(saveTimer);
      const text = readText(element);
      saveTimer = setTimeout(() => saveDraft(text), SAVE_DEBOUNCE_MS);
    },
    true,
  );

  // Sending clears the composer, which arrives as an input event with empty
  // text — handled above. This covers the panel going away mid-edit.
  window.addEventListener('pagehide', () => {
    const composer = document.querySelector(COMPOSER_SELECTOR);
    if (composer) saveDraft(readText(composer));
  });

  async function restore() {
    if (restored) return true;
    const composer = document.querySelector(COMPOSER_SELECTOR);
    if (!composer) return false;
    if (readText(composer).trim()) return true; // the panel filled it itself

    const drafts = await loadDrafts();
    const draft = drafts[tabId];
    if (!draft?.text) return true;
    if (Date.now() - draft.savedAt > MAX_AGE_MS) return true;

    restored = true;
    writeText(composer, draft.text);
    return true;
  }

  // The composer only exists once React has rendered, so watch for it rather
  // than guessing at a delay.
  const observer = new MutationObserver(() => {
    restore().then((done) => {
      if (done) observer.disconnect();
    });
  });

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () =>
      observer.observe(document.body, { childList: true, subtree: true }),
    );
  } else {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Give up watching after a while; a panel that never renders a composer is
  // not going to grow one.
  setTimeout(() => observer.disconnect(), 30_000);
})();
