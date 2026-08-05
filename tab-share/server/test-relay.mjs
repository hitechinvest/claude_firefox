// Интеграционный тест PHP-релея. Поднимает `php -S` во временной копии,
// играет роль расширения (host) и гостя (viewer), гоняет полный цикл.
//
//   node test-relay.mjs      (нужен php в PATH, Node 18+)

import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = "testsession01";
const HOST_KEY = "hostkey_0123456789abcdef";
const PIN = "123456";

let passed = 0, failed = 0;
const ok = (c, m) => (c ? (passed++, console.log("  ✓", m)) : (failed++, console.error("  ✗", m)));

const work = mkdtempSync(path.join(tmpdir(), "tabshare-"));
for (const f of ["relay.php", "viewer.php"]) copyFileSync(path.join(__dirname, f), path.join(work, f));

// PHP_CLI_SERVER_WORKERS даёт встроенному серверу несколько процессов —
// иначе long-poll заблокировал бы единственный воркер (на реальном хостинге
// с PHP-FPM запросы обслуживаются параллельно).
const php = spawn("php", ["-S", `127.0.0.1:${PORT}`, "-t", work], {
  stdio: "ignore",
  env: { ...process.env, PHP_CLI_SERVER_WORKERS: "6" },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relay = (a, extra = "") =>
  `${BASE}/relay.php?action=${a}&session=${SESSION}&host_key=${HOST_KEY}${extra}`;

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/relay.php?action=meta&session=x"); return true; } catch (e) { await sleep(100); }
  }
  throw new Error("php server не поднялся");
}

async function main() {
  await waitUp();

  // 1. start
  let r = await fetch(relay("start", "&pin=" + PIN), { method: "POST" });
  ok(r.ok, "start: сессия создана");

  // 2. чужой host_key не может перезапустить сессию
  r = await fetch(`${BASE}/relay.php?action=start&session=${SESSION}&host_key=another_key_1234567890&pin=000`, { method: "POST" });
  ok(r.status === 403, "start чужим host_key отклонён (session busy)");

  // 3. host заливает кадр
  r = await fetch(relay("frame"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: new TextEncoder().encode("JPEG-FRAME-1") });
  let j = await r.json();
  ok(r.ok && j.ver === 1, "frame #1 принят, ver=1");

  // 4. guest с неверным PIN — 403
  r = await fetch(`${BASE}/relay.php?action=view&session=${SESSION}&pin=999999&viewer=guestone&since=-1`);
  ok(r.status === 403, "view с неверным PIN отклонён");

  // 5. guest получает кадр
  r = await fetch(`${BASE}/relay.php?action=view&session=${SESSION}&pin=${PIN}&viewer=guestone&since=-1`);
  const body = await r.text();
  ok(r.status === 200 && body === "JPEG-FRAME-1" && r.headers.get("x-frame-ver") === "1",
     "view вернул кадр #1 с X-Frame-Ver=1");

  // 6. guest шлёт ввод
  r = await fetch(`${BASE}/relay.php?action=input&session=${SESSION}&pin=${PIN}&viewer=guestone`,
    { method: "POST", body: JSON.stringify({ t: "input", payload: { kind: "click", x: 0.5, y: 0.25 } }) });
  ok(r.ok, "input от гостя принят");

  r = await fetch(`${BASE}/relay.php?action=input&session=${SESSION}&pin=${PIN}&viewer=guestone`,
    { method: "POST", body: JSON.stringify({ t: "nav", payload: { action: "reload" } }) });
  ok(r.ok, "nav от гостя принят");

  // 7. host забирает очередь ввода и видит зрителя
  r = await fetch(relay("pull"), { method: "POST" });
  j = await r.json();
  ok(j.events.length === 2 && j.events[0].payload.kind === "click" && j.events[1].payload.action === "reload",
     "pull вернул оба события в порядке");
  ok(j.viewers === 1, "pull видит 1 зрителя");

  // очередь очищена
  r = await fetch(relay("pull"), { method: "POST" });
  j = await r.json();
  ok(j.events.length === 0, "очередь ввода очищается после pull");

  // 8. long-poll: view висит и получает новый кадр, залитый параллельно
  const pending = fetch(`${BASE}/relay.php?action=view&session=${SESSION}&pin=${PIN}&viewer=guestone&since=1`);
  setTimeout(() => {
    fetch(relay("frame"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: new TextEncoder().encode("JPEG-FRAME-2") });
  }, 500);
  r = await pending;
  const b2 = await r.text();
  ok(r.status === 200 && b2 === "JPEG-FRAME-2" && r.headers.get("x-frame-ver") === "2",
     "long-poll дождался кадра #2");

  // 9. stop и проверка, что сессия исчезла
  r = await fetch(relay("stop"), { method: "POST" });
  ok(r.ok, "stop выполнен");
  r = await fetch(`${BASE}/relay.php?action=view&session=${SESSION}&pin=${PIN}&viewer=guestone&since=-1`);
  ok(r.status === 404, "после stop сессии больше нет (404)");
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    php.kill(); rmSync(work, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error("Тест упал:", e.message);
    php.kill(); rmSync(work, { recursive: true, force: true });
    process.exit(1);
  });
