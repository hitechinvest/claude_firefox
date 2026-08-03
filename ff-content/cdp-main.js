/**
 * Page-world half of the CDP shim (MAIN world, document_start, all frames).
 *
 * Everything here has to run in the page's own JavaScript context rather than
 * the isolated content-script world:
 *
 *   - `Input.*` needs to drive React-style controlled inputs, which only react
 *     to the *native* value setter being called on the page's own prototypes.
 *   - `Page.handleJavaScriptDialog` needs to intercept `window.alert` and
 *     friends, which live on the page's window.
 *   - `Runtime.consoleAPICalled` needs the page's console.
 *
 * It talks to ff-content/cdp-agent.js over `window.postMessage`.  That channel
 * is readable by the page by construction — the MAIN world offers no isolation
 * — so nothing secret goes through it, and the agent treats everything arriving
 * from it as untrusted input.
 */

(() => {
  'use strict';

  const CHANNEL = '__ffCdpMain';
  if (window[CHANNEL]) return; // already injected into this document
  window[CHANNEL] = true;

  /** Interception stays inert until Page.enable / Runtime.enable arms it. */
  const config = { interceptDialogs: false, forwardConsole: false };

  function post(payload) {
    try {
      // '*' rather than the document origin: sandboxed and about:blank frames
      // have an opaque origin that postMessage refuses to match.
      window.postMessage({ [CHANNEL]: true, ...payload }, '*');
    } catch {
      /* the page tore down the messaging plumbing; nothing useful to do */
    }
  }

  function emit(method, params) {
    post({ kind: 'event', method, params });
  }

  // -------------------------------------------------------------------------
  // dialogs
  // -------------------------------------------------------------------------

  /**
   * Set by Page.handleJavaScriptDialog.  Real CDP blocks the page until the
   * client answers; we cannot suspend synchronous JS, so a dialog is answered
   * from the standing policy and the event is reported after the fact.
   */
  const dialogPolicy = { accept: false, promptText: null };

  function reportDialog(type, message, defaultPrompt) {
    emit('Page.javascriptDialogOpening', {
      url: String(location.href),
      message: String(message ?? ''),
      type,
      hasBrowserHandler: false,
      defaultPrompt: defaultPrompt == null ? undefined : String(defaultPrompt),
    });
  }

  const nativeAlert = window.alert;
  const nativeConfirm = window.confirm;
  const nativePrompt = window.prompt;

  window.alert = function alert(message) {
    if (!config.interceptDialogs) return nativeAlert.call(window, message);
    reportDialog('alert', message);
    return undefined;
  };

  window.confirm = function confirm(message) {
    if (!config.interceptDialogs) return nativeConfirm.call(window, message);
    reportDialog('confirm', message);
    return dialogPolicy.accept;
  };

  window.prompt = function prompt(message, defaultValue) {
    if (!config.interceptDialogs) return nativePrompt.call(window, message, defaultValue);
    reportDialog('prompt', message, defaultValue);
    if (!dialogPolicy.accept) return null;
    return dialogPolicy.promptText ?? defaultValue ?? '';
  };

  // A beforeunload prompt cannot be answered after the fact either, so while
  // interception is armed we report it and stop the page's own handlers from
  // running — which is what "accept and navigate away" looks like from outside.
  window.addEventListener(
    'beforeunload',
    (event) => {
      if (!config.interceptDialogs) return;
      reportDialog('beforeunload', '');
      event.stopImmediatePropagation();
      delete event.returnValue;
    },
    true,
  );

  // -------------------------------------------------------------------------
  // console + exceptions
  // -------------------------------------------------------------------------

  function describe(value) {
    const type = value === null ? 'object' : typeof value;
    let description;
    try {
      description = type === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
      description = String(value);
    }
    return { type, value: type === 'object' ? undefined : value, description };
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = function (...args) {
      if (config.forwardConsole) {
        emit('Runtime.consoleAPICalled', {
          type: level,
          args: args.map(describe),
          timestamp: Date.now(),
          executionContextId: 1,
        });
      }
      return original.apply(this, args);
    };
  }

  window.addEventListener('error', (event) => {
    if (!config.forwardConsole) return;
    emit('Runtime.exceptionThrown', {
      timestamp: Date.now(),
      exceptionDetails: {
        exceptionId: 0,
        text: String(event.message ?? 'Uncaught error'),
        lineNumber: event.lineno ?? 0,
        columnNumber: event.colno ?? 0,
        url: String(event.filename ?? location.href),
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!config.forwardConsole) return;
    emit('Runtime.exceptionThrown', {
      timestamp: Date.now(),
      exceptionDetails: {
        exceptionId: 0,
        text: `Uncaught (in promise) ${String(event.reason)}`,
        lineNumber: 0,
        columnNumber: 0,
        url: String(location.href),
      },
    });
  });

  // -------------------------------------------------------------------------
  // input synthesis
  // -------------------------------------------------------------------------

  const CDP_MODIFIER = { ALT: 1, CTRL: 2, META: 4, SHIFT: 8 };

  function modifierFlags(modifiers = 0) {
    return {
      altKey: Boolean(modifiers & CDP_MODIFIER.ALT),
      ctrlKey: Boolean(modifiers & CDP_MODIFIER.CTRL),
      metaKey: Boolean(modifiers & CDP_MODIFIER.META),
      shiftKey: Boolean(modifiers & CDP_MODIFIER.SHIFT),
    };
  }

  const MOUSE_BUTTON = { none: -1, left: 0, middle: 1, right: 2, back: 3, forward: 4 };

  function elementAt(x, y) {
    return document.elementFromPoint(x, y) ?? document.documentElement ?? document.body;
  }

  function mouseInit(params) {
    const button = MOUSE_BUTTON[params.button ?? 'left'] ?? 0;
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: params.x,
      clientY: params.y,
      screenX: (window.screenX ?? 0) + params.x,
      screenY: (window.screenY ?? 0) + params.y,
      button: button < 0 ? 0 : button,
      buttons: params.buttons ?? 0,
      detail: params.clickCount ?? 0,
      ...modifierFlags(params.modifiers),
    };
  }

  function dispatchMouse(params) {
    const target = elementAt(params.x, params.y);
    if (!target) return { dispatched: false };
    const init = mouseInit(params);

    switch (params.type) {
      case 'mousePressed': {
        target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', init));
        // Match the browser: pressing focusable content moves focus to it.
        const focusable = target.closest?.(
          'a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable="true"]',
        );
        if (focusable && typeof focusable.focus === 'function') {
          focusable.focus({ preventScroll: true });
        }
        return { dispatched: true };
      }
      case 'mouseReleased': {
        target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', init));
        if ((params.clickCount ?? 0) > 0 && (params.button ?? 'left') === 'left') {
          target.dispatchEvent(new MouseEvent('click', init));
          if (params.clickCount === 2) {
            target.dispatchEvent(new MouseEvent('dblclick', init));
          }
        }
        if ((params.button ?? 'left') === 'right') {
          target.dispatchEvent(new MouseEvent('contextmenu', init));
        }
        return { dispatched: true };
      }
      case 'mouseMoved': {
        target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousemove', init));
        return { dispatched: true };
      }
      case 'mouseWheel': {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            ...init,
            deltaX: params.deltaX ?? 0,
            deltaY: params.deltaY ?? 0,
            deltaMode: 0,
          }),
        );
        // Synthetic wheel events do not scroll anything, so do it explicitly.
        scrollFrom(target, params.deltaX ?? 0, params.deltaY ?? 0);
        return { dispatched: true };
      }
      default:
        return { dispatched: false };
    }
  }

  function scrollFrom(element, deltaX, deltaY) {
    let node = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight;
      const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX) &&
        node.scrollWidth > node.clientWidth;
      if (scrollsY || scrollsX) {
        node.scrollBy(scrollsX ? deltaX : 0, scrollsY ? deltaY : 0);
        return;
      }
      node = node.parentElement;
    }
    window.scrollBy(deltaX, deltaY);
  }

  const KEY_EVENT_TYPE = {
    keyDown: 'keydown',
    rawKeyDown: 'keydown',
    keyUp: 'keyup',
    char: 'keypress',
  };

  function dispatchKey(params) {
    const type = KEY_EVENT_TYPE[params.type];
    if (!type) return { dispatched: false };
    const target = document.activeElement ?? document.body;
    if (!target) return { dispatched: false };

    const event = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: params.key ?? params.text ?? '',
      code: params.code ?? '',
      location: params.location ?? 0,
      repeat: Boolean(params.autoRepeat),
      ...modifierFlags(params.modifiers),
    });

    // KeyboardEvent derives keyCode/which and ignores them in the init dict,
    // so they arrive as 0.  Plenty of page code still reads them.
    const legacyCode = params.windowsVirtualKeyCode ?? 0;
    for (const name of ['keyCode', 'which', 'charCode']) {
      Object.defineProperty(event, name, {
        get: () => (name === 'charCode' && type !== 'keypress' ? 0 : legacyCode),
        configurable: true,
      });
    }

    const notCancelled = target.dispatchEvent(event);

    // Printable keydowns have to edit the field themselves: a synthetic event
    // has no default action.
    if (notCancelled && params.type === 'keyDown' && params.text && params.text.length === 1) {
      insertText(params.text, target);
    }
    if (notCancelled && params.type === 'keyDown' && params.key === 'Backspace') {
      deleteBackwards(target);
    }
    return { dispatched: true };
  }

  /** React and friends only notice value changes made through the prototype setter. */
  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function insertText(text, explicitTarget) {
    const target = explicitTarget ?? document.activeElement;
    if (!target) return { inserted: false };

    if (target.isContentEditable) {
      document.execCommand('insertText', false, text);
      return { inserted: true };
    }
    if (!('value' in target)) return { inserted: false };

    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next = target.value.slice(0, start) + text + target.value.slice(end);
    setNativeValue(target, next);
    try {
      target.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* selection is not supported on this input type */
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return { inserted: true };
  }

  function deleteBackwards(target) {
    if (!target) return;
    if (target.isContentEditable) {
      document.execCommand('delete', false);
      return;
    }
    if (!('value' in target)) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const from = start === end ? Math.max(0, start - 1) : start;
    setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
    try {
      target.setSelectionRange(from, from);
    } catch {
      /* selection is not supported on this input type */
    }
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
    );
  }

  function layoutMetrics() {
    const doc = document.documentElement;
    const viewport = {
      pageX: window.scrollX,
      pageY: window.scrollY,
      clientWidth: doc.clientWidth,
      clientHeight: doc.clientHeight,
      scale: 1,
    };
    const contentSize = {
      x: 0,
      y: 0,
      width: Math.max(doc.scrollWidth, doc.clientWidth),
      height: Math.max(doc.scrollHeight, doc.clientHeight),
    };
    return {
      layoutViewport: viewport,
      visualViewport: {
        ...viewport,
        offsetX: 0,
        offsetY: 0,
        zoom: window.devicePixelRatio || 1,
      },
      contentSize,
      cssLayoutViewport: viewport,
      cssVisualViewport: { ...viewport, offsetX: 0, offsetY: 0, zoom: 1 },
      cssContentSize: contentSize,
    };
  }

  // -------------------------------------------------------------------------
  // command dispatch
  // -------------------------------------------------------------------------

  const HANDLERS = {
    'Agent.configure': (params) => {
      if (typeof params.interceptDialogs === 'boolean') {
        config.interceptDialogs = params.interceptDialogs;
      }
      if (typeof params.forwardConsole === 'boolean') {
        config.forwardConsole = params.forwardConsole;
      }
      return { ...config };
    },
    'Page.handleJavaScriptDialog': (params) => {
      dialogPolicy.accept = Boolean(params.accept);
      dialogPolicy.promptText = params.promptText ?? null;
      return {};
    },
    'Page.getLayoutMetrics': () => layoutMetrics(),
    'Input.dispatchMouseEvent': (params) => dispatchMouse(params),
    'Input.dispatchKeyEvent': (params) => dispatchKey(params),
    'Input.insertText': (params) => insertText(String(params.text ?? '')),
    'Input.synthesizeScrollGesture': (params) => {
      scrollFrom(elementAt(params.x ?? 0, params.y ?? 0), -(params.xDistance ?? 0), -(params.yDistance ?? 0));
      return {};
    },
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true || data.kind !== 'request') return;

    const handler = HANDLERS[data.method];
    let response;
    if (!handler) {
      response = { ok: false, error: `unknown page command '${data.method}'` };
    } else {
      try {
        response = { ok: true, result: handler(data.params ?? {}) ?? {} };
      } catch (error) {
        response = { ok: false, error: String(error?.message ?? error) };
      }
    }
    post({ kind: 'response', id: data.id, ...response });
  });
})();
