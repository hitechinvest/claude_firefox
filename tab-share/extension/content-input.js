"use strict";

// Проигрывает ввод удалённого пользователя в расшаренной вкладке и, в
// HTML-режиме, отдаёт снимок DOM для зеркалирования у гостя.
//
// Координаты приходят нормализованными [0..1]. В JPEG-режиме — относительно
// вьюпорта; в HTML-режиме гость видит весь документ, поэтому там координаты
// относительно полного размера документа (payload.doc === true).
//
// Важно: синтетические события имеют isTrusted === false. Для большинства
// сайтов и React-приложений этого достаточно, но страницы, проверяющие
// isTrusted, и нативный UI браузера так управлять нельзя (см. README).

(() => {
  if (window.__tabShareInputInstalled) return;
  window.__tabShareInputInstalled = true;

  // Перевод нормализованных координат в координаты вьюпорта.
  // В HTML-режиме (input.doc) точка задана долей от всего документа —
  // при необходимости подкручиваем прокрутку, чтобы цель попала во вьюпорт.
  function resolvePoint(input) {
    if (input.doc) {
      const de = document.documentElement;
      const dw = Math.max(de.scrollWidth, window.innerWidth);
      const dh = Math.max(de.scrollHeight, window.innerHeight);
      const X = input.x * dw, Y = input.y * dh;
      let vx = X - window.scrollX, vy = Y - window.scrollY;
      if (vx < 0 || vy < 0 || vx >= window.innerWidth || vy >= window.innerHeight) {
        window.scrollTo(Math.max(0, X - window.innerWidth / 2), Math.max(0, Y - window.innerHeight / 2));
        vx = X - window.scrollX;
        vy = Y - window.scrollY;
      }
      return { x: Math.round(vx), y: Math.round(vy) };
    }
    return { x: Math.round(input.x * window.innerWidth), y: Math.round(input.y * window.innerHeight) };
  }

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
      const p = resolvePoint(input);
      const opts = {
        ctrlKey: input.ctrlKey, shiftKey: input.shiftKey, altKey: input.altKey, metaKey: input.metaKey,
      };
      if (kind === "click") doClick(p.x, p.y, input.button || 0, opts);
      else if (kind === "dblclick") {
        doClick(p.x, p.y, 0, opts);
        fireMouse("dblclick", p.x, p.y, 0, { ...opts, detail: 2 });
      } else fireMouse(kind, p.x, p.y, input.button || 0, opts);
    } else if (kind === "wheel") {
      const p = resolvePoint(input);
      const el = targetAt(p.x, p.y);
      if (el) el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y,
        deltaX: input.deltaX || 0, deltaY: input.deltaY || 0,
      }));
      window.scrollBy(input.deltaX || 0, input.deltaY || 0);
    } else if (kind === "key") {
      handleKey(input);
    }
  }

  // --- снимок DOM для HTML-режима -----------------------------------------
  // Клонируем документ, переносим в клон текущие значения полей (их нет в
  // outerHTML), выкидываем <script> и ставим <base href>, чтобы относительные
  // ссылки на CSS/картинки резолвились у гостя относительно исходной страницы.
  function buildSnapshot() {
    const de = document.documentElement;
    const clone = de.cloneNode(true);

    const sel = "input, textarea, select, option";
    const live = document.querySelectorAll(sel);
    const cloned = clone.querySelectorAll(sel);
    for (let i = 0; i < live.length && i < cloned.length; i++) {
      const l = live[i], c = cloned[i];
      const tag = l.tagName.toLowerCase();
      if (tag === "input") {
        const type = (l.type || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          if (l.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked");
        } else {
          c.setAttribute("value", l.value);
        }
      } else if (tag === "textarea") {
        c.textContent = l.value;
      } else if (tag === "option") {
        if (l.selected) c.setAttribute("selected", ""); else c.removeAttribute("selected");
      }
    }

    clone.querySelectorAll("script").forEach((s) => s.remove());

    let head = clone.querySelector("head");
    if (!head) {
      head = document.createElement("head");
      clone.insertBefore(head, clone.firstChild);
    }
    head.querySelectorAll("base").forEach((b) => b.remove());
    const base = document.createElement("base");
    base.setAttribute("href", document.baseURI);
    head.insertBefore(base, head.firstChild);

    return {
      html: "<!DOCTYPE html>\n" + clone.outerHTML,
      dw: Math.max(de.scrollWidth, window.innerWidth),
      dh: Math.max(de.scrollHeight, window.innerHeight),
      sx: window.scrollX,
      sy: window.scrollY,
    };
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.ch === "ts-input" && msg.input) {
      try { apply(msg.input); } catch (e) {}
    } else if (msg.ch === "ts-snapshot") {
      try {
        return Promise.resolve(buildSnapshot());
      } catch (e) {
        return Promise.resolve(null);
      }
    }
  });
})();
