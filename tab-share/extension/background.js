"use strict";

// Фоновый скрипт расширения Tab Share (вариант с PHP-релеем).
//
// Всё идёт через ваш сайт: расширение снимает выбранную вкладку и POST-ит
// кадры на relay.php, а ввод гостя забирает оттуда же опросом. Гость открывает
// viewer.php на том же сайте. Слушать порт локально не нужно — точка встречи
// это ваш сервер.

const state = {
  running: false,
  connecting: false,
  tabId: null,
  tabTitle: "",
  tabUrl: "",
  relayUrl: "",
  session: "",
  hostKey: "",
  fps: 3,
  quality: 55,
  token: "", // это PIN для гостя
  accessUrl: "", // ссылка на viewer.php
  viewers: 0,
  lastError: "",
};

let captureGen = 0;
let pullGen = 0;

// --- утилиты -------------------------------------------------------------

function hex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function genPin() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  let n = 0;
  for (const x of b) n = (n * 256 + x) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}

function broadcastState() {
  browser.runtime.sendMessage({ evt: "state", state }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ color: "#38a169" }).catch(() => {});
  browser.browserAction.setBadgeText({ text: state.running ? "ON" : "" }).catch(() => {});
}

function setError(msg) {
  state.lastError = msg || "";
  broadcastState();
}

function relay(action, extra = "") {
  const sep = state.relayUrl.includes("?") ? "&" : "?";
  return (
    state.relayUrl +
    sep +
    "action=" + action +
    "&session=" + encodeURIComponent(state.session) +
    "&host_key=" + encodeURIComponent(state.hostKey) +
    extra
  );
}

function guestUrlFrom(relayUrl, session) {
  let base = relayUrl.replace(/[?#].*$/, "");
  base = base.replace(/[^/]*$/, ""); // отрезаем имя файла
  return base + "viewer.php?s=" + encodeURIComponent(session);
}

// --- захват вкладки → relay ---------------------------------------------

async function startCaptureLoop() {
  const gen = ++captureGen;
  while (state.running && gen === captureGen) {
    const t0 = Date.now();
    try {
      const dataUrl = await browser.tabs.captureTab(state.tabId, { format: "jpeg", quality: state.quality });
      const blob = await (await fetch(dataUrl)).blob();
      const resp = await fetch(relay("frame"), {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (resp.ok) {
        const j = await resp.json().catch(() => null);
        if (j && typeof j.viewers === "number" && j.viewers !== state.viewers) {
          state.viewers = j.viewers;
          broadcastState();
        }
        if (state.lastError) setError("");
      } else {
        const j = await resp.json().catch(() => null);
        setError("Релей: " + resp.status + (j && j.error ? " " + j.error : ""));
      }
    } catch (e) {
      // captureTab падает на привилегированных страницах; fetch — при сетевой ошибке
      setError("Кадр не отправлен: " + e.message);
    }
    const wait = Math.max(0, Math.round(1000 / state.fps) - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait || Math.round(1000 / state.fps)));
  }
}

// --- опрос ввода гостей --------------------------------------------------

async function startPullLoop() {
  const gen = ++pullGen;
  while (state.running && gen === pullGen) {
    try {
      const resp = await fetch(relay("pull"), { method: "POST" });
      if (resp.ok) {
        const j = await resp.json();
        if (j && typeof j.viewers === "number") state.viewers = j.viewers;
        if (j && Array.isArray(j.events)) {
          for (const ev of j.events) {
            if (ev.t === "input") handleRemoteInput(ev.payload || {});
            else if (ev.t === "nav") handleRemoteNav(ev.payload || {});
          }
        }
        broadcastState();
      }
    } catch (e) {
      // сеть моргнула — попробуем на следующем витке
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

// --- проигрывание ввода в целевой вкладке --------------------------------

async function ensureContentScript() {
  try {
    await browser.tabs.executeScript(state.tabId, { file: "content-input.js" });
  } catch (e) {}
}

function handleRemoteInput(payload) {
  if (!state.running || state.tabId == null) return;
  browser.tabs.sendMessage(state.tabId, { ch: "ts-input", input: payload }).catch(async () => {
    await ensureContentScript();
    browser.tabs.sendMessage(state.tabId, { ch: "ts-input", input: payload }).catch(() => {});
  });
}

async function handleRemoteNav(payload) {
  if (!state.running || state.tabId == null) return;
  try {
    switch (payload.action) {
      case "goto": {
        let url = String(payload.url || "").trim();
        if (!url) return;
        if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith("about:")) url = "http://" + url;
        await browser.tabs.update(state.tabId, { url });
        break;
      }
      case "back": await browser.tabs.goBack(state.tabId); break;
      case "forward": await browser.tabs.goForward(state.tabId); break;
      case "reload": await browser.tabs.reload(state.tabId); break;
    }
  } catch (e) {
    setError("Навигация: " + e.message);
  }
}

// --- старт / стоп --------------------------------------------------------

async function startSharing(cfg) {
  if (state.running || state.connecting) await hardStop(true);

  const relayUrl = String(cfg.relayUrl || "").trim();
  if (!/^https?:\/\//i.test(relayUrl)) {
    setError("Укажите URL relay.php (например https://ваш-сайт/tabshare/relay.php)");
    return;
  }

  const tab = cfg.tabId
    ? await browser.tabs.get(cfg.tabId)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) { setError("Вкладка не найдена"); return; }

  state.tabId = tab.id;
  state.tabTitle = tab.title || "";
  state.tabUrl = tab.url || "";
  state.relayUrl = relayUrl;
  state.session = hex(12);
  state.hostKey = hex(24);
  state.token = genPin();
  state.fps = Math.min(10, Math.max(1, parseInt(cfg.fps, 10) || 3));
  state.quality = Math.min(90, Math.max(20, parseInt(cfg.quality, 10) || 55));
  state.viewers = 0;
  state.lastError = "";
  state.connecting = true;
  state.accessUrl = "";
  broadcastState();

  await browser.storage.local.set({ relayUrl }).catch(() => {});

  try {
    const resp = await fetch(relay("start", "&pin=" + encodeURIComponent(state.token)), { method: "POST" });
    if (!resp.ok) {
      const j = await resp.json().catch(() => null);
      state.connecting = false;
      setError("Релей отклонил start: " + resp.status + (j && j.error ? " " + j.error : ""));
      return;
    }
  } catch (e) {
    state.connecting = false;
    setError("Не достучаться до релея: " + e.message + ". Проверьте URL и что PHP-файл загружен.");
    return;
  }

  state.connecting = false;
  state.running = true;
  state.accessUrl = guestUrlFrom(relayUrl, state.session);
  broadcastState();

  await ensureContentScript();
  startCaptureLoop();
  startPullLoop();
}

async function hardStop(silent) {
  captureGen++;
  pullGen++;
  const wasRunning = state.running || state.connecting;
  const hadSession = state.running && state.relayUrl && state.session;
  state.running = false;
  state.connecting = false;
  if (hadSession) {
    fetch(relay("stop"), { method: "POST" }).catch(() => {});
  }
  state.viewers = 0;
  state.accessUrl = "";
  if (wasRunning && !silent) broadcastState();
}

// --- реакция на изменения вкладки ----------------------------------------

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.running || tabId !== state.tabId) return;
  if (changeInfo.title) state.tabTitle = changeInfo.title;
  if (changeInfo.url) state.tabUrl = changeInfo.url;
  if (changeInfo.title || changeInfo.url) broadcastState();
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (state.running && tabId === state.tabId) {
    setError("Расшаренная вкладка закрыта — доступ остановлен");
    hardStop();
  }
});

browser.webNavigation.onCommitted.addListener((d) => {
  if (state.running && d.tabId === state.tabId && d.frameId === 0) ensureContentScript();
});

// --- сообщения из popup --------------------------------------------------

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || !msg.cmd) return;
  switch (msg.cmd) {
    case "getState": {
      const tabs = await browser.tabs.query({});
      const list = tabs
        .filter((t) => t.id != null)
        .map((t) => ({ id: t.id, title: t.title || t.url || "вкладка", url: t.url || "", active: !!t.active }));
      const saved = await browser.storage.local.get("relayUrl").catch(() => ({}));
      return { state, tabs: list, savedRelayUrl: saved.relayUrl || "" };
    }
    case "start":
      await startSharing(msg);
      return { ok: true };
    case "stop":
      await hardStop();
      return { ok: true };
  }
});
