/**
 * Bootstrap for the Firefox compatibility layer.
 *
 * Firefox already exposes a callback-style `chrome` namespace, so most of the
 * extension runs untouched.  What it does not expose is `chrome.debugger`,
 * `chrome.sidePanel`, `chrome.offscreen` and a handful of `chrome.runtime`
 * members.  Rather than patch the (minified) bundle, we put a proxy in front of
 * the global `chrome` object so the later shim modules can add namespaces to it.
 *
 * The proxy also gives us a writable `chrome.runtime.lastError`: the extension
 * checks it inside our callbacks to tell success from failure, and the native
 * property is read-only.
 *
 * This module must be the first entry in `background.scripts`.
 */

const NATIVE = globalThis.chrome;

if (!NATIVE || !NATIVE.runtime) {
  throw new Error('[ff-port] no WebExtension API in the background context');
}

/** namespace name -> shim object, e.g. `debugger`, `sidePanel`, `offscreen` */
const namespaces = Object.create(null);
/** member name -> shim value, e.g. `getContexts`, `ContextType` */
const runtimeMembers = Object.create(null);

const NO_ERROR = Symbol('no-error');
let pendingLastError = NO_ERROR;

/** Methods pulled off a native namespace lose their receiver; rebind them. */
function bind(target, value) {
  return typeof value === 'function' ? value.bind(target) : value;
}

const runtimeProxy = new Proxy(NATIVE.runtime, {
  get(target, prop) {
    if (prop === 'lastError' && pendingLastError !== NO_ERROR) {
      return pendingLastError;
    }
    if (prop in runtimeMembers) return runtimeMembers[prop];
    return bind(target, Reflect.get(target, prop));
  },
  has(target, prop) {
    return prop in runtimeMembers || Reflect.has(target, prop);
  },
  set(target, prop, value) {
    if (prop in runtimeMembers) {
      runtimeMembers[prop] = value;
      return true;
    }
    return Reflect.set(target, prop, value);
  },
});

const chromeProxy = new Proxy(NATIVE, {
  get(target, prop) {
    if (prop === 'runtime') return runtimeProxy;
    if (prop in namespaces) return namespaces[prop];
    return bind(target, Reflect.get(target, prop));
  },
  has(target, prop) {
    return prop in namespaces || Reflect.has(target, prop);
  },
  set(target, prop, value) {
    if (prop in namespaces) {
      namespaces[prop] = value;
      return true;
    }
    return Reflect.set(target, prop, value);
  },
});

globalThis.chrome = chromeProxy;
// `browser` is left alone: it is promise-based, and the ported bundle is
// Chrome code that expects callbacks.

/**
 * Run `cb` with `chrome.runtime.lastError` visible, the way a native callback
 * would see it.  `error` may be null for the success case.
 */
function invokeCallback(cb, args, error) {
  if (typeof cb !== 'function') return;
  const previous = pendingLastError;
  pendingLastError = error
    ? { message: error instanceof Error ? error.message : String(error) }
    : NO_ERROR;
  try {
    cb(...args);
  } catch (err) {
    console.error('[ff-port] callback threw', err);
  } finally {
    pendingLastError = previous;
  }
}

/**
 * Adapt a promise-returning implementation to Chrome's dual
 * promise/callback calling convention.
 */
function callbackable(impl) {
  return function (...args) {
    let cb;
    if (typeof args[args.length - 1] === 'function') cb = args.pop();
    const promise = (async () => impl(...args))();
    if (!cb) return promise;
    promise.then(
      (result) => invokeCallback(cb, [result], null),
      (error) => invokeCallback(cb, [undefined], error),
    );
    return undefined;
  };
}

/** Minimal stand-in for a chrome.events.Event. */
function makeEvent(name) {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
    /** not part of the API surface — used by the shims to fire the event */
    dispatch(...args) {
      for (const fn of [...listeners]) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[ff-port] ${name} listener threw`, err);
        }
      }
    },
  };
}

const DEBUG_PREF = '__ffPortDebug';
let debugEnabled = false;
NATIVE.storage?.local
  ?.get(DEBUG_PREF)
  .then((v) => {
    debugEnabled = Boolean(v?.[DEBUG_PREF]);
  })
  .catch(() => {});

globalThis.__ffPort = {
  NATIVE,
  invokeCallback,
  callbackable,
  makeEvent,
  registerNamespace(name, value) {
    namespaces[name] = value;
  },
  /**
   * Add members to a namespace Firefox does implement, without hiding the
   * native ones.  Anything the native object already has wins, so this only
   * fills genuine gaps.
   */
  extendNamespace(name, extras) {
    const target = NATIVE[name];
    if (!target) {
      namespaces[name] = extras;
      return;
    }
    namespaces[name] = new Proxy(target, {
      get(object, prop) {
        if (!(prop in object) && prop in extras) return extras[prop];
        return bind(object, Reflect.get(object, prop));
      },
      has(object, prop) {
        return prop in extras || Reflect.has(object, prop);
      },
    });
  },
  registerRuntimeMember(name, value) {
    runtimeMembers[name] = value;
  },
  log(...args) {
    if (debugEnabled) console.debug('[ff-port]', ...args);
  },
  warn(...args) {
    console.warn('[ff-port]', ...args);
  },
};
