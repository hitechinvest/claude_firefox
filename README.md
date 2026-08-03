# Claude для Firefox

Порт расширения [Claude для Chrome](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn)
на Firefox.

Репозиторий содержит не само расширение, а **инструмент, который его портирует**:
скачивает свежую сборку из Chrome Web Store, переписывает манифест и подставляет
слой совместимости для API, которых в Firefox нет. Код Anthropic сюда не
копируется — подробности в [NOTICE.md](NOTICE.md).

Побочный эффект такого подхода: когда Anthropic выкатывает новую версию, порт
обновляется одной командой, а не переносом патчей вручную.

## Сборка

Нужны Python 3.10+ и Firefox 139+.

```
python3 port.py            # скачать текущую версию из CWS и собрать в build/
python3 tools/verify.py    # статические проверки собранного расширения
```

Другие источники, если не хочется ходить в сеть:

```
python3 port.py --crx claude.crx      # из локального .crx
python3 port.py --src unpacked/       # из распакованной папки
python3 port.py --xpi                 # дополнительно упаковать в dist/*.xpi
```

## Установка

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`build/manifest.json`.

Временное расширение живёт до перезапуска браузера. Постоянная установка из
файла требует подписи AMO, а её здесь получить нельзя — см. [NOTICE.md](NOTICE.md).
Если нужно надолго, подойдёт Firefox Developer Edition или Nightly с
`xpinstall.signatures.required=false` в `about:config`.

Дальше — обычный вход в аккаунт Claude. Порт ничего не меняет в аутентификации
и не снимает ограничений тарифа.

## Что переписано

| Chrome | Firefox | Как |
| --- | --- | --- |
| `background.service_worker` | нет | событийная страница через `background.scripts` |
| `chrome.sidePanel` | нет | `sidebarAction` — `ff-shim/20-sidepanel.js` |
| `chrome.debugger` (CDP) | **нет вообще** | эмуляция на `tabs`/`scripting`/`webRequest`/`webNavigation` — `ff-shim/40-debugger.js` + `ff-content/cdp-*.js` |
| `chrome.offscreen` | нет | скрытый iframe в фоновой странице — `ff-shim/30-offscreen.js` |
| `externally_connectable` | нет | мост `postMessage` на claude.ai — `ff-shim/50-external.js` + `ff-content/claude-bridge*.js` |
| `runtime.getContexts` / `ContextType` | частично | нормализация боковой панели — `ff-shim/10-runtime.js` |
| `declarativeNetRequest.RuleActionType`, `HeaderOperation` | нет констант | значения-перечисления — `ff-shim/60-dnr.js` |
| `manifest.key`, `update_url`, `use_dynamic_url`, `storage.managed_schema` | нет | удалены |
| `browser_specific_settings.gecko.id` | обязателен | добавлен |

Всё остальное — `tabGroups`, `declarativeNetRequest`, `scripting` с миром `MAIN`,
`identity`, `nativeMessaging`, `notifications`, `alarms`, `downloads`,
`webNavigation`, `commands` — Firefox поддерживает, и оно уезжает в сборку без
изменений.

Минимальная версия 139 продиктована `tabGroups`: бандл обращается к нему более
чем в 60 местах, и заглушка тут была бы хуже настоящего API.

## Как работает эмуляция `chrome.debugger`

Расширение использует не весь CDP, а узкий срез: скриншоты, синтетический ввод,
`Runtime.evaluate`, события навигации и сети, обработку диалогов. Для каждого
нашёлся аналог в обычных API:

```
Page.captureScreenshot      -> tabs.captureTab (rect/scale ложатся на clip)
Page.navigate / reload      -> tabs.update / tabs.reload
Page.frameNavigated         -> webNavigation.onCommitted
Page.handleJavaScriptDialog -> перехват alert/confirm/prompt в мире MAIN
Input.dispatch* / insertText-> синтетические события в мире MAIN
Runtime.evaluate            -> scripting.executeScript, world: MAIN
Runtime.consoleAPICalled    -> перехват console в мире MAIN
Network.*                   -> webRequest
```

Часть в мире `MAIN` нужна не для красоты: контролируемые поля React реагируют
только на нативный сеттер `value`, а `window.alert` живёт в контексте страницы.
Перехват включается в конкретной вкладке только после `Page.enable` /
`Runtime.enable`, так что на страницах, которыми расширение не управляет,
поведение не меняется.

## Что работает иначе

Это ограничения самой платформы, а не недоделки — обойти их в рамках
WebExtensions нельзя.

**Синтетический ввод не доверенный.** У событий `isTrusted === false`. Обычные
страницы и React-приложения этого не замечают, но сайты, которые проверяют
флаг, кликов не увидят. И до браузерного UI — адресной строки, файловых
диалогов, окон авторизации ОС — синтетический ввод не достаёт вовсе.

**Диалоги обрабатываются постфактум.** Настоящий CDP останавливает страницу до
ответа клиента. Синхронный `window.confirm` так не приостановить, поэтому шим
отвечает по текущей политике и только потом сообщает о диалоге. Для
`beforeunload` эмулируется «принять»: обработчики страницы не запускаются, и
навигация проходит без запроса.

**`Runtime.evaluate` подчиняется CSP страницы.** Выражение выполняется через
косвенный `eval` в мире страницы. Там, где CSP запрещает `unsafe-eval`, вызов
упадёт — в Chrome через CDP он бы прошёл.

**Скриншоты — только видимая часть.** `tabs.captureTab` снимает вьюпорт;
`captureBeyondViewport` аналога не имеет.

**Боковая панель — на окно, а не на вкладку.** Firefox устроен так. Порт держит
разные URL панели для разных вкладок через `sidebarAction.setPanel({tabId})`,
поэтому при переключении вкладок панель перезагружается.

**`sidebarAction.open()` требует жеста пользователя.** По клику на иконку всё
хорошо. Для `Ctrl+E` шим вешает свой обработчик раньше расширения — иначе жест
теряется в асинхронном `tabs.query`.

**Управляемое хранилище.** `storage.managed_schema` в Firefox не поддерживается;
корпоративные политики через этот ключ не заедут.

## Заметки по безопасности

Скрипты в мире `MAIN` по определению доступны странице — изоляции там нет.
Поэтому через канал `postMessage` между `cdp-main.js` и `cdp-agent.js` не
передаётся ничего секретного, а всё пришедшее оттуда считается недоверенным
вводом. Страница может подделать событие CDP; больше ей это не даёт ничего.

Мост claude.ai объявлен в манифесте только для `https://claude.ai/*` и
`https://*.claude.ai/*`, поэтому проверка `sender.origin`, которую делает
расширение, остаётся осмысленной: произвольный сайт не может выдать себя за
claude.ai.

## Тесты

```
node tools/smoke_test.mjs   # поведение шимов в моке WebExtension API
python3 tools/verify.py     # манифест, файлы, дрейф API
npx web-ext lint --source-dir build --self-hosted
```

`smoke_test.mjs` грузит шимы в том же порядке, что и манифест, и прогоняет по
ним тот Chrome-образный API, который реально вызывает бандл: `lastError` в
колбэках, маппинг команд CDP, генерацию событий, мост внешних сообщений.

`verify.py` заодно следит за дрейфом апстрима. Если Anthropic начнёт
использовать ещё какой-нибудь API, которого нет в Firefox, проверка это
покажет — минифицированный бандл сам об этом не сообщит.

## Обновление на новую версию расширения

```
python3 port.py && python3 tools/verify.py && node tools/smoke_test.mjs
```

Если `verify.py` ругается на неизвестный API — значит, апстрим добавил что-то
новое и нужен ещё один шим в `ff-shim/`.

## Структура

```
port.py                        сборщик: скачать → распаковать → пропатчить → собрать
ff-shim/00-bootstrap.js        прокси над chrome.*, записываемый lastError
ff-shim/10-runtime.js          runtime.getContexts / ContextType
ff-shim/20-sidepanel.js        chrome.sidePanel -> sidebarAction
ff-shim/30-offscreen.js        chrome.offscreen -> iframe
ff-shim/40-debugger.js         chrome.debugger -> эмуляция CDP
ff-shim/50-external.js         runtime.onMessageExternal
ff-shim/60-dnr.js              константы declarativeNetRequest
ff-content/cdp-main.js         мир MAIN: ввод, диалоги, console
ff-content/cdp-agent.js        изолированный мир: мост со страницей
ff-content/claude-bridge*.js   канал claude.ai <-> расширение
tools/verify.py                статические проверки сборки
tools/smoke_test.mjs           поведенческие тесты шимов
```
