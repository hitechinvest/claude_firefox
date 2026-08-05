"use strict";

// Проигрывает ввод удалённого пользователя в расшаренной вкладке.
// Координаты приходят нормализованными [0..1] относительно вьюпорта.
//
// Важно: синтетические события имеют isTrusted === false. Для большинства
// сайтов и React-приложений этого достаточно, но страницы, проверяющие
// isTrusted, и нативный UI браузера так управлять нельзя (см. README).

(() => {
  if (window.__tabShareInputInstalled) return;
  window.__tabShareInputInstalled = true;

  const px = (nx) => Math.round(nx * window.innerWidth);
  const py = (ny) => Math.round(ny * window.innerHeight);

  function targetAt(x, y) {
    return document.elementFromPoint(x, y) || document.body || document.documentElement;
  }

  function fireMouse(type, x, y, button, opts = {}) {
    const el = targetAt(x, y);
    if (!el) return el;
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: button || 0,
      buttons: opts.buttons != null ? opts.buttons : type === "mousedown" ? 1 : 0,
      ctrlKey: !!opts.ctrlKey,
      shiftKey: !!opts.shiftKey,
      altKey: !!opts.altKey,
      metaKey: !!opts.metaKey,
      detail: opts.detail || 1,
    });
    el.dispatchEvent(ev);
    return el;
  }

  function doClick(x, y, button, opts) {
    fireMouse("mousemove", x, y, button, opts);
    const el = fireMouse("mousedown", x, y, button, opts);
    // фокус на интерактивных элементах — чтобы потом принимать ввод с клавиатуры
    if (el && typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {}
    }
    fireMouse("mouseup", x, y, button, opts);
    if (button === 2) {
      fireMouse("contextmenu", x, y, button, opts);
    } else {
      fireMouse("click", x, y, button, { ...opts, detail: 1 });
      // клик по ссылке/кнопке: подстрахуем нативное действие
      const a = el && el.closest ? el.closest("a[href],button,input[type=submit]") : null;
      if (a && typeof a.click === "function" && el === a) {
        // el.dispatchEvent('click') уже вызвал default action для большинства случаев
      }
    }
  }

  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "range", "color"].includes(t);
    }
    return el.isContentEditable;
  }

  function nativeSetValue(el, value) {
    const proto = el.tagName.toLowerCase() === "textarea"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function insertText(el, text) {
    if (el.isContentEditable) {
      document.execCommand("insertText", false, text);
      return;
    }
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    const v = el.value;
    nativeSetValue(el, v.slice(0, start) + text + v.slice(end));
    const pos = start + text.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch (e) {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
  }

  function editKey(el, key) {
    if (el.isContentEditable) {
      if (key === "Backspace") document.execCommand("delete", false);
      else if (key === "Delete") document.execCommand("forwardDelete", false);
      return true;
    }
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    const v = el.value;
    if (key === "Backspace") {
      if (start === end && start > 0) {
        nativeSetValue(el, v.slice(0, start - 1) + v.slice(end));
        try { el.setSelectionRange(start - 1, start - 1); } catch (e) {}
      } else if (start !== end) {
        nativeSetValue(el, v.slice(0, start) + v.slice(end));
        try { el.setSelectionRange(start, start); } catch (e) {}
      }
    } else if (key === "Delete") {
      if (start === end && end < v.length) {
        nativeSetValue(el, v.slice(0, start) + v.slice(end + 1));
        try { el.setSelectionRange(start, start); } catch (e) {}
      } else if (start !== end) {
        nativeSetValue(el, v.slice(0, start) + v.slice(end));
        try { el.setSelectionRange(start, start); } catch (e) {}
      }
    } else {
      return false;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
    return true;
  }

  function fireKey(type, info) {
    const el = document.activeElement || document.body;
    const ev = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: info.key,
      code: info.code || "",
      keyCode: info.keyCode || 0,
      which: info.keyCode || 0,
      ctrlKey: !!info.ctrlKey,
      shiftKey: !!info.shiftKey,
      altKey: !!info.altKey,
      metaKey: !!info.metaKey,
    });
    el.dispatchEvent(ev);
    return el;
  }

  function handleKey(info) {
    const el = fireKey("keydown", info);
    const editable = isEditable(el);
    const printable = info.key && info.key.length === 1 && !info.ctrlKey && !info.metaKey && !info.altKey;

    if (editable) {
      if (printable) {
        insertText(el, info.key);
      } else if (info.key === "Enter" && el.tagName && el.tagName.toLowerCase() === "textarea") {
        insertText(el, "\n");
      } else if (info.key === "Backspace" || info.key === "Delete") {
        editKey(el, info.key);
      } else if (info.key === "Enter") {
        // submit формы, если поле в форме
        const form = el.form;
        if (form) {
          const submit = form.querySelector("[type=submit],button:not([type])");
          if (submit) submit.click();
          else if (typeof form.requestSubmit === "function") form.requestSubmit();
        }
      }
    }
    fireKey("keyup", info);
  }

  function apply(input) {
    const kind = input.kind;
    if (kind === "click" || kind === "dblclick" || kind === "mousedown" || kind === "mouseup" || kind === "mousemove") {
      const x = px(input.x), y = py(input.y);
      const opts = {
        ctrlKey: input.ctrlKey, shiftKey: input.shiftKey, altKey: input.altKey, metaKey: input.metaKey,
      };
      if (kind === "click") doClick(x, y, input.button || 0, opts);
      else if (kind === "dblclick") {
        doClick(x, y, 0, opts);
        fireMouse("dblclick", x, y, 0, { ...opts, detail: 2 });
      } else fireMouse(kind, x, y, input.button || 0, opts);
    } else if (kind === "wheel") {
      const x = px(input.x), y = py(input.y);
      const el = targetAt(x, y);
      if (el) el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
        deltaX: input.deltaX || 0, deltaY: input.deltaY || 0,
      }));
      window.scrollBy(input.deltaX || 0, input.deltaY || 0);
    } else if (kind === "key") {
      handleKey(input);
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.ch === "ts-input" && msg.input) {
      try {
        apply(msg.input);
      } catch (e) {
        // не роняем страницу из-за одного события
      }
    }
  });
})();
