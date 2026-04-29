# wz-monitor

Сервис, который держит залогиненную сессию на
[Workzilla](https://work-zilla.com) (страница исполнителя
`https://client.work-zilla.com/freelancer`), каждые ~30 секунд читает ленту
«Новые задания» и шлёт пуш-уведомление в Telegram про каждое только-что
появившееся задание — с заголовком, ценой, кратким описанием, сроком и
кнопкой-ссылкой «Открыть на Workzilla».

Полезно фрилансерам на work-zilla, у которых задания разбираются за секунды и
нужно мгновенно видеть подходящие заказы, не сидя в браузере 24/7.

## Содержание

- [Как это работает](#как-это-работает)
- [Что попадает в уведомление](#что-попадает-в-уведомление)
- [Требования](#требования)
- [Быстрый старт (локально)](#быстрый-старт-локально)
- [Получение `storageState.json`](#получение-storagestatejson)
- [Деплой на VPS (systemd)](#деплой-на-vps-systemd)
- [Конфигурация](#конфигурация)
- [Структура проекта](#структура-проекта)
- [Обновление сессии](#обновление-сессии)
- [Безопасность](#безопасность)
- [Известные ограничения](#известные-ограничения)
- [Лицензия](#лицензия)

## Как это работает

Workzilla не отдаёт публичный API для ленты заданий. Внутренний эндпоинт
(`/api/order/v6/list/open`) требует HttpOnly-куки `Bearer`, серверный
fingerprint-заголовок `agentid` и понимание long-poll-протокола, поэтому
вместо реверса HTTP сервис использует **headless Chromium через
[Playwright](https://playwright.dev)** — браузер заходит на страницу
обычным способом со всеми куки, а скрипт читает карточки заданий из DOM.

```
┌───────────────────────────────────────────────────────────────────┐
│  systemd unit (wz-monitor.service)                                │
│   └─ node src/index.js                                            │
│        ├─ Playwright headless Chromium (storageState.json)        │
│        ├─ открытая /freelancer, page.reload каждые POLL_INTERVAL  │
│        ├─ DOM scrape → {id,title,price,deadline,description,url}  │
│        ├─ diff с seen.json → новые id                             │
│        ├─ Telegram Bot API: sendMessage с inline-кнопкой          │
│        └─ если редирект на /account/login → алерт «обнови сессию» │
└───────────────────────────────────────────────────────────────────┘
```

- **Холодный старт.** При первом запуске видимые в этот момент задания
  помечаются «уже видел» и НЕ присылаются в Telegram. Уведомления приходят
  только про задания, появившиеся после старта.
- **Дедуп.** ID задания вытаскивается из ссылки `/freelancer/order/<id>`
  и хранится в `seen.json` (atomic write через tmpfile+rename).
- **Истечение сессии.** Если сервер редиректит на `/account/login`, сервис
  присылает в Telegram алерт «🔐 Сессия истекла, обнови `storageState.json`»,
  засыпает на 5 минут и пробует снова — после ручной перевыдачи
  сессии всё подхватится автоматически.
- **Ротация куков.** На каждом визите Workzilla обновляет `Bearer`-cookie.
  Сервис каждые ~5 минут сохраняет актуальный `storageState.json` обратно
  на диск, чтобы перезапуск не вернул его к устаревшему снимку.
- **Telegram rate-limit.** Очередь с паузой 1.1с между сообщениями, чтобы
  не упереться в лимиты Bot API при волне новых заданий.

## Что попадает в уведомление

```
Заголовок задания (жирным)
💰 Цена   ⏱ Срок

Краткое описание (до ~300 символов)

[ 🔗 Открыть на Workzilla ]   ← inline-кнопка, ведёт на client.work-zilla.com
```

## Требования

- **Локально** (для разработки и получения `storageState.json`):
  Node.js ≥ 20, npm.
- **Сервер** (для деплоя): Linux с systemd. Скрипт `scripts/deploy.sh`
  заточен под Ubuntu 22.04/24.04 (apt-зависимости для headless-Chromium).
  Понадобится root-доступ по SSH (по ключу или по паролю через `sshpass`).
- **Telegram-бот.** Создаётся через [@BotFather](https://t.me/BotFather):
  `/newbot` → токен. Чтобы бот мог писать в личку — отправь ему любое
  сообщение из своего аккаунта; chat-id посмотри через
  [@userinfobot](https://t.me/userinfobot) или
  `https://api.telegram.org/bot<TOKEN>/getUpdates`.

## Быстрый старт (локально)

```bash
git clone <your-fork-url> wz-monitor
cd wz-monitor
npm install
npx playwright install chromium

cp .env.example .env.local
# отредактируй .env.local — туда вписать TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID

npm run capture          # откроется headed-Chromium → залогинься на work-zilla → Enter в терминале
npm run dev              # локальный запуск с автоподгрузкой .env.local
```

При запуске в логе должно появиться `cold start: marked N task(s) as seen`,
после чего сервис начнёт пинговать страницу каждые `POLL_INTERVAL_MS`
миллисекунд.

## Получение `storageState.json`

Это снимок куков и localStorage авторизованной сессии — без него бот
получит только страницу логина.

### Способ 1 — интерактивный логин (рекомендуется)

```bash
npm run capture
```

Откроется headed-Chrome. Войди в свой аккаунт работника на work-zilla,
дождись пока попадёшь на `/freelancer` и увидишь свою ленту, затем нажми
Enter в терминале — скрипт сохранит `storageState.json` рядом с
проектом (chmod 600).

### Способ 2 — импорт из живого профиля Playwright-MCP

Если ты уже залогинен в Playwright-MCP-браузере (например, открыл его из
Claude Code), скрипт может вытащить сессию напрямую из его профиля:

```bash
node scripts/import-from-mcp-profile.js [profileDir] [outputPath]
# по умолчанию ищет ~/Library/Caches/ms-playwright/mcp-chrome-*
```

Скрипт копирует профиль в `tmp`, чтобы не конфликтовать с активным
браузером, открывает его в headless-Chromium и экспортирует
`storageState.json`.

## Деплой на VPS (systemd)

Скрипт `scripts/deploy.sh` делает всё за один раз: ставит Node.js 20+,
зависимости headless-Chromium, заводит сервис-юзера `wz`, синкает код в
`/opt/wz-monitor`, кладёт секреты в `/var/lib/wz-monitor/`, разворачивает
systemd-юнит и запускает сервис.

```bash
# с паролем (через sshpass, должен быть установлен: brew install sshpass / apt install sshpass)
SSH_PASS='<root-password>' ./scripts/deploy.sh root@<your.server.ip>

# или по SSH-ключу
./scripts/deploy.sh root@<your.server.ip>
```

После успешного деплоя:

```bash
ssh root@<your.server.ip> 'systemctl status wz-monitor'
ssh root@<your.server.ip> 'journalctl -u wz-monitor -f'
```

### Что делает скрипт на сервере

1. Ставит Node.js ≥ 20 из NodeSource (если нет).
2. `apt install` зависимостей headless-Chromium (libnss3, libdrm2, …).
3. Создаёт системного пользователя `wz` с домашней директорией
   `/var/lib/wz-monitor` (там лежит state).
4. `rsync` кода в `/opt/wz-monitor`, `npm install --omit=dev`,
   `playwright install chromium`.
5. Загружает `.env` (из `.env.server` или `.env.local`) и
   `storageState.json` с правами `600` и владельцем `wz`.
6. Прописывает на сервере правильные пути в `.env`
   (`STORAGE_STATE_PATH`, `SEEN_STORE_PATH`).
7. Ставит и стартует systemd-юнит из `systemd/wz-monitor.service`.

### Опциональный `.env.server`

Если для прода нужны параметры, отличные от `.env.local` (другой
интервал опроса, другой бот, другой `LOG_LEVEL`), создай `.env.server` —
скрипт деплоя использует его вместо `.env.local`. Файл также в `.gitignore`.

## Конфигурация

Все настройки — через переменные окружения (см. `.env.example`).

| Переменная             | По умолчанию                                  | Описание |
| ---------------------- | --------------------------------------------- | -------- |
| `TELEGRAM_BOT_TOKEN`   | — (обязательно)                               | Токен от @BotFather |
| `TELEGRAM_CHAT_ID`     | — (обязательно)                               | Куда слать уведомления |
| `POLL_INTERVAL_MS`     | `30000`                                       | Период опроса страницы (ms) |
| `STORAGE_STATE_PATH`   | `./storageState.json`                         | Снимок авторизованной сессии Playwright |
| `SEEN_STORE_PATH`      | `./seen.json`                                 | JSON-файл с id уже отправленных заданий |
| `WZ_FREELANCER_URL`    | `https://client.work-zilla.com/freelancer`    | URL страницы «Новые» |
| `LOG_LEVEL`            | `info`                                        | `error` / `warn` / `info` / `debug` |

## Структура проекта

```
.
├── src/
│   ├── index.js          # главный цикл, обработка истёкшей сессии и rate-limit
│   ├── scrape.js         # запуск Playwright, навигация, defence-in-depth на /account/login
│   ├── parse.js          # извлечение карточек заданий из DOM (in-page evaluate)
│   ├── store.js          # JSON-стор виденных id (atomic write)
│   ├── telegram.js       # Bot API + очередь с паузой 1.1с между sendMessage
│   └── config.js         # чтение env, логгер
├── scripts/
│   ├── capture-session.js         # интерактивный логин → storageState.json
│   ├── import-from-mcp-profile.js # экспорт сессии из живого профиля Playwright-MCP
│   └── deploy.sh                  # provisioning + rsync + systemd
├── systemd/
│   └── wz-monitor.service         # unit-файл, ProtectSystem=strict, ReadWritePaths=/var/lib/wz-monitor
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Обновление сессии

Когда в Telegram приходит алерт `🔐 Сессия истекла. Обнови
storageState.json и перезапусти сервис.`:

```bash
# на машине разработки
npm run capture

# залить новый снимок на сервер
SSH_PASS='...' rsync -az storageState.json root@<your.server.ip>:/var/lib/wz-monitor/
ssh root@<your.server.ip> 'chown wz:wz /var/lib/wz-monitor/storageState.json \
                        && chmod 600 /var/lib/wz-monitor/storageState.json \
                        && systemctl restart wz-monitor'
```

Сервис подхватит файл автоматически — `seen.json` сохраняется, дублей не
будет.

## Безопасность

- **`.env`, `.env.local`, `.env.server`, `storageState.json` НЕ
  коммитятся** — они в `.gitignore`. Прежде чем что-то выкладывать на
  GitHub, проверь `git status` — этих файлов там быть не должно.
- На сервере секреты лежат с правами `chmod 600` и владельцем
  системного юзера `wz`, который не может логиниться (`/usr/sbin/nologin`).
- Сервис работает не из-под root, а из-под `wz`. Systemd-юнит включает
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `ReadWritePaths=/var/lib/wz-monitor`.
- Bot token нигде не логируется.
- **Никогда не публикуй `storageState.json`** — там HttpOnly-куки,
  включая `Bearer`, который даёт полный доступ к твоему аккаунту
  Workzilla.
- Если деплоишь по паролю, после успешного деплоя имеет смысл переключить
  SSH на ключи и выключить парольный логин в `/etc/ssh/sshd_config`.

## Известные ограничения

- **Изменение фронтенда Workzilla.** Парсер опирается на эвристические
  селекторы (`[class*="title"]`, `[class*="price"]` и т.п.). Если WZ
  переделает разметку, может потребоваться правка `src/parse.js`.
- **Каптча/анти-бот.** На сильно подозрительный трафик WZ может выкатить
  каптчу — тогда headless-сессия разломается. В этом случае придётся
  либо разредить опрос, либо переключиться на использование SignalR
  WebSocket-хаба `/msg/msgs-hub`, который сайт сам открывает для пушей.
- **Размер ленты.** При очень широких фильтрах Telegram быстро упрётся в
  rate-limit. Решение: сузить фильтры в личном кабинете на сайте, или
  добавить в код отсечку по минимальной цене (тривиально расширяется в
  `src/index.js`).

## Лицензия

Не определена — добавь по своему вкусу (для open-source проектов чаще
всего MIT).
