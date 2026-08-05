<?php
// Tab Share — релей. Единственная точка, через которую идёт всё:
// расширение (host) шлёт сюда кадры и забирает ввод, гость (viewer) забирает
// кадры и шлёт ввод. Состояние хранится в файлах в ./data.
//
// Роли и секреты:
//   host_key — длинный секрет, знает только расширение. Нужен для start/frame/pull/stop.
//   pin      — короткий код для гостя. Нужен для view/input.
//   session  — случайный идентификатор трансляции (в имени файлов).
//
// Развёртывание: положить relay.php и viewer.php в одну папку на сайте с PHP.
// Папка ./data будет создана автоматически и должна быть доступна на запись.

declare(strict_types=1);

// ------------------------------------------------------------------ утилиты

const MAX_FRAME_BYTES   = 8 * 1024 * 1024; // 8 МБ на кадр — с запасом
const VIEWER_TTL        = 15;              // сек: гость «жив», если стучался недавно
const LONGPOLL_SECONDS  = 10;              // сколько держать view без нового кадра
const LONGPOLL_STEP_US  = 200000;          // 0.2 c шаг опроса

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg]);
    exit;
}

function ok(array $data = []): never {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data);
    exit;
}

function param(string $name, string $default = ''): string {
    return isset($_REQUEST[$name]) ? (string)$_REQUEST[$name] : $default;
}

function safe_session(string $s): string {
    if ($s === '' || !preg_match('/^[A-Za-z0-9_-]{6,64}$/', $s)) fail(400, 'bad session');
    return $s;
}

function data_root(): string {
    $root = __DIR__ . '/data';
    if (!is_dir($root)) {
        @mkdir($root, 0700, true);
        // закрываем прямой доступ к кадрам/секретам из веба
        @file_put_contents($root . '/.htaccess', "Require all denied\nDeny from all\n");
        @file_put_contents($root . '/index.html', '');
    }
    if (!is_dir($root) || !is_writable($root)) fail(500, 'data dir not writable: ' . $root);
    return $root;
}

function session_dir(string $session, bool $create = false): string {
    $dir = data_root() . '/' . $session;
    if ($create && !is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir)) fail(404, 'no such session');
    return $dir;
}

function read_meta(string $dir): array {
    $raw = @file_get_contents($dir . '/meta.json');
    if ($raw === false) fail(404, 'no session meta');
    $m = json_decode($raw, true);
    return is_array($m) ? $m : [];
}

function require_host(string $dir): array {
    $meta = read_meta($dir);
    if (!hash_equals((string)($meta['host_key'] ?? ''), param('host_key'))) fail(403, 'bad host_key');
    return $meta;
}

function require_pin(string $dir): array {
    $meta = read_meta($dir);
    if (!hash_equals((string)($meta['pin'] ?? ''), param('pin'))) fail(403, 'bad pin');
    return $meta;
}

function touch_viewer(string $dir, string $viewer): void {
    if (!preg_match('/^[A-Za-z0-9_-]{4,64}$/', $viewer)) return;
    $vd = $dir . '/viewers';
    if (!is_dir($vd)) @mkdir($vd, 0700, true);
    @touch($vd . '/' . $viewer);
}

function count_viewers(string $dir): int {
    $vd = $dir . '/viewers';
    if (!is_dir($vd)) return 0;
    $n = 0; $now = time();
    foreach (@scandir($vd) ?: [] as $f) {
        if ($f[0] === '.') continue;
        $mt = @filemtime($vd . '/' . $f);
        if ($mt !== false && $now - $mt <= VIEWER_TTL) $n++;
        elseif ($mt !== false) @unlink($vd . '/' . $f);
    }
    return $n;
}

function current_ver(string $dir): int {
    return (int)@file_get_contents($dir . '/frame.ver');
}

// ------------------------------------------------------------------ действия

$action = param('action');

switch ($action) {

// host: создать/пересоздать сессию
case 'start': {
    $session = safe_session(param('session'));
    $host_key = param('host_key');
    $pin = param('pin');
    if (strlen($host_key) < 16) fail(400, 'host_key too short');
    if ($pin === '') fail(400, 'pin required');
    $dir = session_dir($session, true);
    // если сессия уже есть — менять секреты может только владелец host_key
    if (is_file($dir . '/meta.json')) {
        $old = read_meta($dir);
        if (($old['host_key'] ?? '') !== '' && !hash_equals((string)$old['host_key'], $host_key)) {
            fail(403, 'session busy');
        }
    }
    file_put_contents($dir . '/meta.json', json_encode([
        'host_key' => $host_key,
        'pin'      => $pin,
        'created'  => time(),
        'host_seen'=> time(),
    ]));
    @file_put_contents($dir . '/frame.ver', '0');
    @file_put_contents($dir . '/input.log', '');
    ok(['session' => $session]);
}

// host: залить свежий кадр (тело запроса — сырой JPEG)
case 'frame': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    require_host($dir);
    $body = file_get_contents('php://input');
    if ($body === false || $body === '') fail(400, 'empty frame');
    if (strlen($body) > MAX_FRAME_BYTES) fail(413, 'frame too large');
    // тип кадра: image/* (JPEG) или text/html (зеркало DOM)
    $ct = (string)($_SERVER['CONTENT_TYPE'] ?? 'image/jpeg');
    if (!preg_match('#^(image/[\w.+-]+|text/html)#i', $ct)) $ct = 'application/octet-stream';
    // необязательная мета (для HTML — размеры документа), приходит urlencoded
    $fmeta = param('meta');
    if (strlen($fmeta) > 4096) $fmeta = '';
    file_put_contents($dir . '/frame.ct', substr($ct, 0, 120));
    file_put_contents($dir . '/frame.meta', $fmeta);
    $tmp = $dir . '/frame.tmp';
    file_put_contents($tmp, $body);
    @rename($tmp, $dir . '/frame.bin');
    $ver = current_ver($dir) + 1;
    file_put_contents($dir . '/frame.ver', (string)$ver);
    $meta = read_meta($dir);
    $meta['host_seen'] = time();
    file_put_contents($dir . '/meta.json', json_encode($meta));
    ok(['ver' => $ver, 'viewers' => count_viewers($dir)]);
}

// host: забрать накопившийся ввод гостей и очистить очередь
case 'pull': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    require_host($dir);
    $events = [];
    $log = $dir . '/input.log';
    $fp = @fopen($log, 'c+');
    if ($fp) {
        flock($fp, LOCK_EX);
        $content = stream_get_contents($fp);
        ftruncate($fp, 0);
        flock($fp, LOCK_UN);
        fclose($fp);
        foreach (explode("\n", (string)$content) as $line) {
            $line = trim($line);
            if ($line === '') continue;
            $ev = json_decode($line, true);
            if (is_array($ev)) $events[] = $ev;
        }
    }
    ok(['events' => $events, 'viewers' => count_viewers($dir)]);
}

// host: остановить трансляцию и удалить всё
case 'stop': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    require_host($dir);
    // рекурсивно чистим папку сессии
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
    @rmdir($dir);
    ok();
}

// guest: получить кадр (long-poll). since=последняя версия у гостя
case 'view': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    require_pin($dir);
    touch_viewer($dir, param('viewer'));
    $since = (int)param('since', '-1');
    $deadline = microtime(true) + LONGPOLL_SECONDS;
    do {
        $ver = current_ver($dir);
        if ($ver > $since && is_file($dir . '/frame.bin')) {
            $bytes = file_get_contents($dir . '/frame.bin');
            if ($bytes !== false) {
                $ct = @file_get_contents($dir . '/frame.ct');
                header('Content-Type: ' . ($ct !== false && $ct !== '' ? $ct : 'image/jpeg'));
                header('X-Frame-Ver: ' . $ver);
                $fmeta = @file_get_contents($dir . '/frame.meta');
                if ($fmeta !== false && $fmeta !== '') header('X-Frame-Meta: ' . $fmeta);
                header('Cache-Control: no-store');
                echo $bytes;
                exit;
            }
        }
        usleep(LONGPOLL_STEP_US);
    } while (microtime(true) < $deadline);
    http_response_code(204); // за отведённое время нового кадра не появилось
    header('X-Frame-Ver: ' . current_ver($dir));
    exit;
}

// guest: отправить событие ввода/навигации
case 'input': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    require_pin($dir);
    touch_viewer($dir, param('viewer'));
    $body = file_get_contents('php://input');
    $ev = json_decode((string)$body, true);
    if (!is_array($ev)) fail(400, 'bad event');
    // пропускаем только известные формы, чтобы не писать мусор
    $t = (string)($ev['t'] ?? '');
    if ($t !== 'input' && $t !== 'nav') fail(400, 'bad type');
    $line = json_encode(['t' => $t, 'payload' => $ev['payload'] ?? []]) . "\n";
    $fp = @fopen($dir . '/input.log', 'a');
    if ($fp) { flock($fp, LOCK_EX); fwrite($fp, $line); flock($fp, LOCK_UN); fclose($fp); }
    ok();
}

// guest/host: жив ли эфир
case 'meta': {
    $session = safe_session(param('session'));
    $dir = session_dir($session);
    $meta = read_meta($dir);
    ok([
        'live'     => (time() - (int)($meta['host_seen'] ?? 0)) <= VIEWER_TTL,
        'ver'      => current_ver($dir),
        'viewers'  => count_viewers($dir),
    ]);
}

default:
    fail(400, 'unknown action');
}
