"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setup"), live: $("live"), error: $("error"),
  tab: $("tab"), relay: $("relay"), mode: $("mode"), fps: $("fps"), quality: $("quality"),
  start: $("start"), stop: $("stop"), copy: $("copy"),
  liveTab: $("liveTab"), liveUrl: $("liveUrl"), livePin: $("livePin"), liveViewers: $("liveViewers"),
};

let lastState = null;

function accessLink(state) {
  if (!state.accessUrl) return "";
  const sep = state.accessUrl.includes("#") ? "&" : "#";
  return state.accessUrl + sep + "pin=" + encodeURIComponent(state.token);
}

function render(data) {
  const s = data.state;
  lastState = s;

  if (data.tabs) {
    const cur = els.tab.value;
    els.tab.innerHTML = "";
    for (const t of data.tabs) {
      const o = document.createElement("option");
      o.value = String(t.id);
      o.textContent = (t.active ? "● " : "") + (t.title.length > 46 ? t.title.slice(0, 45) + "…" : t.title);
      els.tab.appendChild(o);
    }
    const activeTab = data.tabs.find((t) => t.active);
    els.tab.value = cur || (activeTab ? String(activeTab.id) : "");
  }

  if (data.savedRelayUrl && !els.relay.value) els.relay.value = data.savedRelayUrl;
  if (data.savedMode && !render._modeSet) { els.mode.value = data.savedMode; render._modeSet = true; }

  const running = s.running || s.connecting;
  els.setup.hidden = running;
  els.live.hidden = !running;

  if (running) {
    els.liveTab.textContent = s.tabTitle || "—";
    els.liveUrl.textContent = s.connecting ? "запуск сервера…" : s.accessUrl || "—";
    els.livePin.textContent = s.token || "—";
    els.liveViewers.textContent = String(s.viewers || 0);
    els.stop.textContent = s.connecting ? "Отмена" : "Остановить";
  }

  els.error.hidden = !s.lastError;
  els.error.textContent = s.lastError || "";
}

async function refresh() {
  const data = await browser.runtime.sendMessage({ cmd: "getState" });
  if (data) render(data);
}

els.start.addEventListener("click", async () => {
  await browser.runtime.sendMessage({
    cmd: "start",
    tabId: parseInt(els.tab.value, 10),
    relayUrl: els.relay.value,
    mode: els.mode.value,
    fps: els.fps.value,
    quality: els.quality.value,
  });
  refresh();
});

els.stop.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ cmd: "stop" });
  refresh();
});

els.copy.addEventListener("click", async () => {
  if (!lastState) return;
  const link = accessLink(lastState);
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    els.copy.textContent = "Скопировано ✓";
    setTimeout(() => (els.copy.textContent = "Скопировать ссылку с PIN"), 1500);
  } catch (e) {
    els.copy.textContent = link;
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.evt === "state") render({ state: msg.state });
});

refresh();
