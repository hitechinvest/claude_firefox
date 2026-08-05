<?php
// Страница-зритель для гостя. Отдаёт HTML и talks к relay.php в той же папке.
// Сессия берётся из ?s=..., PIN — из #pin=... (фрагмент на сервер не уходит)
// или вводится вручную.
$session = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($_GET['s'] ?? ''));
?><!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tab Share — удалённая вкладка</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0f1116; color: #e2e8f0;
    font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
  #bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px;
    background: #1a1f2b; border-bottom: 1px solid #2d3748; }
  #bar button { background: #2d3748; color: #e2e8f0; border: 0; border-radius: 6px;
    padding: 6px 10px; cursor: pointer; font: inherit; }
  #bar button:hover { background: #3a465c; }
  #bar button.on { background: #38a169; color: #fff; }
  #url { flex: 1; padding: 6px 9px; border: 1px solid #2d3748; border-radius: 6px;
    background: #0f1116; color: #e2e8f0; font: inherit; }
  #status { font-size: 12px; color: #a0aec0; white-space: nowrap; }
  #dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #e53e3e; margin-right: 5px; vertical-align: middle; }
  #dot.ok { background: #38a169; }
  #stage { position: relative; height: calc(100% - 45px); display: flex;
    align-items: center; justify-content: center; overflow: auto; background: #0b0d12; }
  #screen { max-width: 100%; max-height: 100%; display: block; user-select: none;
    -webkit-user-drag: none; }
  #overlay { position: fixed; inset: 0; background: rgba(10,12,18,0.94);
    display: flex; align-items: center; justify-content: center; z-index: 10; }
  #card { background: #1a1f2b; padding: 26px 28px; border-radius: 12px; width: 300px;
    text-align: center; border: 1px solid #2d3748; }
  #card h2 { margin: 0 0 14px; font-size: 17px; }
  #pin { width: 100%; padding: 10px; font-size: 20px; letter-spacing: 6px;
    text-align: center; border: 1px solid #2d3748; border-radius: 8px;
    background: #0f1116; color: #e2e8f0; }
  #card button { margin-top: 14px; width: 100%; padding: 10px; border: 0;
    border-radius: 8px; background: #2b6cb0; color: #fff; font: inherit;
    font-weight: 600; cursor: pointer; }
  #msg { margin-top: 10px; font-size: 12px; color: #fc8181; min-height: 16px; }
  .hint { font-size: 11px; color: #718096; margin-top: 8px; }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" title="Назад">◀</button>
    <button id="fwd" title="Вперёд">▶</button>
    <button id="reload" title="Обновить">⟳</button>
    <input id="url" placeholder="Введите адрес и нажмите Enter" spellcheck="false">
    <button id="ctl" class="on" title="Передавать мышь и клавиатуру">Управление: вкл</button>
    <span id="status"><span id="dot"></span><span id="statusText">подключение…</span></span>
  </div>
  <div id="stage">
    <img id="screen" alt="удалённая вкладка" draggable="false">
  </div>

  <div id="overlay">
    <div id="card">
      <h2>Введите PIN-код</h2>
      <input id="pin" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off">
      <button id="enter">Подключиться</button>
      <div id="msg"></div>
      <div class="hint">PIN показан в расширении у того, кто открыл доступ.</div>
    </div>
  </div>

<script>
"use strict";
(function () {
  const SESSION = <?php echo json_encode($session); ?>;
  const RELAY = "relay.php";
  const VIEWER_ID = Math.random().toString(36).slice(2, 12);

  const screen = document.getElementById("screen");
  const overlay = document.getElementById("overlay");
  const pinInput = document.getElementById("pin");
  const enterBtn = document.getElementById("enter");
  const msg = document.getElementById("msg");
  const urlInput = document.getElementById("url");
  const ctlBtn = document.getElementById("ctl");
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("statusText");

  let pin = "";
  let authed = false;
  let control = true;
  let since = -1;
  let stopped = false;

  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get("pin")) pinInput.value = hashParams.get("pin");

  function setStatus(ok, text) { dot.classList.toggle("ok", !!ok); statusText.textContent = text; }
  const q = (extra) => `${RELAY}?action=${extra}&session=${encodeURIComponent(SESSION)}&pin=${encodeURIComponent(pin)}&viewer=${VIEWER_ID}`;

  async function tryAuth() {
    pin = pinInput.value.trim();
    msg.textContent = "проверка…";
    try {
      const r = await fetch(q("view") + "&since=999999999", { cache: "no-store" });
      if (r.status === 403) { msg.textContent = "Неверный PIN или трансляция не найдена"; return; }
      authed = true;
      overlay.style.display = "none";
      setStatus(true, "подключено");
      framePoll();
      inputMeta();
    } catch (e) {
      msg.textContent = "Сервер недоступен";
    }
  }

  // long-poll кадров
  async function framePoll() {
    while (authed && !stopped) {
      try {
        const r = await fetch(q("view") + "&since=" + since, { cache: "no-store" });
        if (r.status === 403) { authed = false; location.reload(); return; }
        const ver = parseInt(r.headers.get("X-Frame-Ver") || String(since), 10);
        if (r.status === 200) {
          since = ver;
          const blob = await r.blob();
          const u = URL.createObjectURL(blob);
          const old = screen.src;
          screen.onload = () => { if (old && old.startsWith("blob:")) URL.revokeObjectURL(old); };
          screen.src = u;
          setStatus(true, "подключено");
        } else if (r.status === 204) {
          since = ver;
        }
      } catch (e) {
        setStatus(false, "переподключение…");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // редкий пинг статуса «в эфире»
  async function inputMeta() {
    while (authed && !stopped) {
      try {
        const r = await fetch(`${RELAY}?action=meta&session=${encodeURIComponent(SESSION)}`, { cache: "no-store" });
        const m = await r.json();
        if (m && m.live === false) setStatus(false, "трансляция остановлена");
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  function sendInput(t, payload) {
    if (!authed) return;
    fetch(q("input"), { method: "POST", body: JSON.stringify({ t, payload }), keepalive: true }).catch(() => {});
  }

  enterBtn.addEventListener("click", tryAuth);
  pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryAuth(); });

  // координаты внутри картинки [0..1]
  function norm(e) {
    const r = screen.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    let y = (e.clientY - r.top) / r.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }
  const mods = (e) => ({ ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });

  let moveThrottle = 0;
  screen.addEventListener("mousemove", (e) => {
    if (!control) return;
    const now = Date.now();
    if (now - moveThrottle < 80) return;
    moveThrottle = now;
    const p = norm(e);
    sendInput("input", { kind: "mousemove", x: p.x, y: p.y, ...mods(e) });
  });
  screen.addEventListener("click", (e) => {
    if (!control) return; e.preventDefault();
    const p = norm(e);
    sendInput("input", { kind: "click", x: p.x, y: p.y, button: 0, ...mods(e) });
  });
  screen.addEventListener("dblclick", (e) => {
    if (!control) return; e.preventDefault();
    const p = norm(e);
    sendInput("input", { kind: "dblclick", x: p.x, y: p.y, button: 0, ...mods(e) });
  });
  screen.addEventListener("contextmenu", (e) => {
    if (!control) return; e.preventDefault();
    const p = norm(e);
    sendInput("input", { kind: "click", x: p.x, y: p.y, button: 2, ...mods(e) });
  });
  screen.addEventListener("wheel", (e) => {
    if (!control) return; e.preventDefault();
    const p = norm(e);
    sendInput("input", { kind: "wheel", x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (!control || !authed) return;
    if (document.activeElement === urlInput || document.activeElement === pinInput) return;
    const printable = e.key.length === 1;
    const special = ["Enter","Backspace","Delete","Tab","Escape","ArrowUp","ArrowDown",
      "ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(e.key);
    if (!printable && !special) return;
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    sendInput("input", { kind: "key", key: e.key, code: e.code, keyCode: e.keyCode,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
  });

  document.getElementById("back").onclick = () => sendInput("nav", { action: "back" });
  document.getElementById("fwd").onclick = () => sendInput("nav", { action: "forward" });
  document.getElementById("reload").onclick = () => sendInput("nav", { action: "reload" });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && urlInput.value.trim()) sendInput("nav", { action: "goto", url: urlInput.value.trim() });
  });
  ctlBtn.addEventListener("click", () => {
    control = !control;
    ctlBtn.classList.toggle("on", control);
    ctlBtn.textContent = "Управление: " + (control ? "вкл" : "выкл");
  });

  if (!SESSION) { setStatus(false, "нет session в ссылке"); overlay.querySelector("h2").textContent = "Ссылка без session"; }
  else { setStatus(false, "введите PIN"); pinInput.focus(); if (pinInput.value.trim()) tryAuth(); }
})();
</script>
</body>
</html>
