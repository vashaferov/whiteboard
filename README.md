# Онлайн-доска для уроков

Совместная интерактивная доска для онлайн-уроков: FastAPI + WebSocket + Konva.js.
Учитель и ученики подключаются к одной комнате по ссылке, рисуют, добавляют фигуры,
текст и изображения, видят курсоры друг друга. Роли и права проверяются на сервере.

## Возможности (MVP)

- Комната урока по `room_id`, вход по ссылке `/?room=math-7b`.
- Роли `teacher` / `student`; учитель входит по коду из `.env`.
- Кисть, ластик, прямоугольник, круг, линия, стрелка, текст.
- Выбор и перемещение объектов (ученик — свои, учитель — любые).
- Масштабирование и поворот фигур, текста и изображений через Transformer.
- Редактирование текста двойным кликом или клавишей `F2`.
- Загрузка изображений через `POST /api/upload` (локально или в S3-совместимом хранилище).
- Курсоры участников с троттлингом.
- Очистка доски, удаление объектов и отключение участника — только учитель.
- Несколько страниц (воркспейсов) в комнате: список видят все, каждый переключается сам.
- Учитель создаёт, переименовывает, удаляет и меняет порядок страниц; переносит одного,
  нескольких или всех учеников на свою текущую страницу. Черновик текста сохраняется на
  старой странице.
- Синхронизация в реальном времени: append-only + last-write-wins.
- Переподключение с exponential backoff и восстановлением снимка через `init`.
- Снимки доски в SQLite: периодически и при опустении комнаты; восстановление после рестарта.
- Redis Pub/Sub и общее состояние комнат для нескольких инстансов (опционально).
- Ограничение частоты сообщений на сервере, валидация всех WS-сообщений через Pydantic.
- Наблюдаемость: `/metrics` (Prometheus), JSON-логи с request-id, Sentry, `/health/ready`.

## Стек

| Слой | Технологии |
|---|---|
| Backend | Python 3.13, FastAPI, Uvicorn, Pydantic v2, PyJWT |
| Хранилище | Память / Redis (активные комнаты) + SQLite (снимки) + S3-совместимое хранилище (изображения) |
| Frontend | HTML5, CSS, Vanilla JS (ES-модули), Konva.js 9 (CDN) |
| Инфраструктура | Docker, docker-compose, Caddy (TLS), GitHub Actions (ruff, black, pytest, Playwright) |
| Наблюдаемость | Prometheus, JSON-логи, Sentry |

## Быстрый старт

```bash
python -m venv .venv
# Windows
.venv\Scripts\pip install -r backend\requirements-dev.txt
# Linux/macOS
# source .venv/bin/activate && pip install -r backend/requirements-dev.txt

copy .env.example .env        # Windows (Linux: cp .env.example .env)
```

Запуск из папки `backend`:

```bash
cd backend
..\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Откройте <http://127.0.0.1:8000>.

- Ученик: имя + комната (код не нужен).
- Учитель: имя + комната + **код учителя** (по умолчанию `teacher`, задаётся `TEACHER_CODE`).
- Ссылка для учеников: `http://127.0.0.1:8000/?room=math-7b`.

## Настройки (`.env`)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `JWT_SECRET` | dev-значение | Секрет подписи JWT — **обязательно поменять в продакшене** |
| `JWT_TTL_HOURS` | `12` | Время жизни токена |
| `TEACHER_CODE` | `teacher` | Код для входа учителем |
| `BOARD_WIDTH` / `BOARD_HEIGHT` | `1600` / `900` | Логический размер доски |
| `MAX_UPLOAD_MB` | `5` | Лимит размера изображения |
| `ROOM_TTL_DAYS` | `30` | Срок хранения снимков комнат |
| `MAX_OBJECTS_PER_ROOM` | `20000` | Лимит объектов на доске |
| `MAX_WORKSPACES_PER_ROOM` | `50` | Лимит страниц (воркспейсов) в комнате |
| `WORKSPACE_MOVE_TIMEOUT_SECONDS` | `2.0` | Ожидание ack при переносе ученика учителем |
| `RATE_LIMIT_*` | 60 / 25 / 40 | Лимиты `stroke_point`, `cursor`, прочих сообщений в секунду |
| `DATA_DIR` / `UPLOADS_DIR` / `FRONTEND_DIR` | папки в корне | Пути к данным, загрузкам и статике |
| `REDIS_URL` | пусто | Включает общее состояние комнат и Pub/Sub; без него — один инстанс |
| `S3_BUCKET` | пусто | Включает S3-хранилище изображений; пусто — локальная папка `uploads` |
| `S3_ENDPOINT_URL` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | Подключение к SeaweedFS / MinIO / AWS S3 |
| `S3_PUBLIC_BASE_URL` | — | Публичный префикс URL изображений |
| `LOG_JSON` / `LOG_LEVEL` | `false` / `INFO` | Формат и уровень логов |
| `SENTRY_DSN` | пусто | Включает отправку ошибок в Sentry |
| `METRICS_ENABLED` | `true` | Публикует `/metrics` |

## Структура проекта

```
backend/
  app/
    main.py                 # FastAPI, статика, health, metrics, request-id, lifespan
    config.py               # настройки из .env
    models/schemas.py       # Pydantic-схемы REST и WS
    api/{auth,ws,upload}.py # логин, WebSocket, загрузка файлов
    services/
      auth.py               # JWT
      room_manager.py       # комнаты, участники, broadcast, rate limit, Redis, воркспейсы
      workspaces.py         # страницы: id, имена, порядок, миграция
      storage.py            # SQLite-снимки
      images.py             # локальное и S3-хранилище изображений
      metrics.py            # Prometheus-метрики
      logging.py            # JSON-логи, request-id, Sentry
  tests/                    # unit + integration (106 тестов)
frontend/
  index.html
  js/{main,board,tools,sync}.js
  js/pages.js               # панель страниц
  css/style.css
e2e/                        # Playwright: урок, права, reconnect, страницы/перенос, mobile
scripts/
  load_test.py              # нагрузка на WebSocket
  backup.py                 # бэкап SQLite + uploads
  backup-docker.sh          # бэкап named volumes production-стека
docs/deploy.md              # production-деплой, TLS, бэкапы, метрики
docs/superpowers/specs/2026-11-15-workspaces-design.md  # дизайн страниц
docs/superpowers/plans/2026-11-15-workspaces.md         # план реализации страниц
Caddyfile
Dockerfile
docker-compose.yml          # dev: whiteboard + Redis + SeaweedFS
docker-compose.prod.yml     # prod: Caddy + whiteboard + Redis + SeaweedFS
.github/workflows/ci.yml
```

## Протокол WebSocket (кратко)

`/ws/{room_id}?token=<JWT>&workspace=<id>` — после подключения сервер присылает `init`
(участники, страницы, текущая страница, объекты только этой страницы, права, размер доски),
затем транслирует события всем, кроме отправителя. `workspace` необязателен: без него
открывается первая страница.

Клиент → сервер: `stroke_start`, `stroke_point`, `stroke_end`, `shape_add`, `text_add`,
`image_add`, `object_update`, `object_transform`, `text_update`, `object_delete`,
`cursor`, `clear`, `kick`, `workspace_switch`, `workspace_create`, `workspace_rename`,
`workspace_delete`, `workspace_reorder`, `workspace_pull`, `workspace_move_ack`.

Сервер → клиент: `init`, `user_joined`, `user_left`, `stroke_*`, `shape_add`, `text_add`,
`image_add`, `object_update`, `object_transform`, `text_update`, `object_delete`,
`cursor`, `cursor_remove`, `workspace_state`, `workspace_created`, `workspace_renamed`,
`workspace_reordered`, `workspace_deleted`, `workspace_prepare_move`, `workspace_moved`,
`clear`, `error`, `kicked`.

Дополнительно к исходной архитектуре:

- `object_update` — перемещение объекта (автор или учитель).
- `object_transform` — resize/rotate (`x`, `y`, `width`, `height`, `rotation`, `fontSize`).
- `text_update` — изменение содержимого текста (автор или учитель).
- `kick` — отключение участника учителем.
- `stroke_end` несёт полный объект штриха, чтобы опоздавшие и переподключившиеся
  клиенты не теряли линию.
- `seq` присваивается сервером при финализации объекта.
- `workspaceId` есть у каждого объектного, курсорного и `clear`-события; сервер доставляет
  такое событие только участникам этой страницы.
- `workspace_state` — `{workspaceId, objects, stateVersion}`: снимок страницы после
  переключения; применяется только более новый `stateVersion`.
- `workspace_prepare_move` → `workspace_move_ack` → `workspace_moved` + `workspace_state` —
  двухфазный перенос: клиент сохраняет черновик текста и финализирует штрих, затем
  подтверждает; если ack не пришёл за `WORKSPACE_MOVE_TIMEOUT_SECONDS`, перенос выполняется
  принудительно.
- Первая страница — `ws_default` («Страница 1»); старые комнаты и снимки мигрируют в неё без
  потери объектов. Лимит объектов и `seq` остаются общими на комнату.

## Тесты и линтеры

```bash
cd backend
..\.venv\Scripts\python -m pytest
..\.venv\Scripts\python -m ruff check .
..\.venv\Scripts\python -m black --check .
```

Покрыто: вход и роли, загрузка изображений (локально и S3 через moto), комнаты и
broadcast, права (`clear`, удаление, перемещение, transform, текст), штрихи,
курсоры/лимиты, kick, восстановление снимка, Redis Pub/Sub и presence на
`fakeredis`, метрики/readiness/JSON-логи, edge cases (размер upload, обрыв во
время штриха, одновременное рисование, невалидные сообщения), страницы
(создание/переименование/удаление/порядок, изоляция объектов, двухфазный перенос,
миграция старых снимков).

E2E в репозитории (Playwright, Chromium):

```bash
cd e2e
npm ci
npx playwright install chromium
# Windows: PYTHON=..\.venv\Scripts\python.exe npx playwright test
npx playwright test
```

Сценарии: основной урок (рисование, курсор, resize/rotate, текст и его
редактирование, reload), права и kick, reconnect, страницы (создание, изоляция,
переключение, переименование, порядок, reload, reconnect, удаление цели
переключения, удаление непустой страницы), перенос учеников (один/все,
сохранение черновика), мобильный viewport.

Нагрузочный тест:

```bash
python scripts/load_test.py --clients 20 --duration 15
```

## Docker

```bash
docker compose up --build
```

Приложение: <http://127.0.0.1:8000>, S3 (SeaweedFS): <http://127.0.0.1:9000>,
UI кластера SeaweedFS: <http://127.0.0.1:9333>. Ключи по умолчанию —
`whiteboard` / `whiteboard-secret` (`S3_ACCESS_KEY` / `S3_SECRET_KEY`).
Compose поднимает Redis и SeaweedFS, поэтому проверяются общее состояние комнат
и S3-загрузки. Перед публикацией задайте `JWT_SECRET`, `TEACHER_CODE` и ключи S3.

Если локальный `uvicorn` уже использует `./data`, остановите его перед запуском
compose: SQLite в режиме WAL не работает через bind mount из двух процессов
одновременно (появится `disk I/O error`).

Production с автоматическим HTTPS, Caddy, бэкапами и масштабированием —
см. [docs/deploy.md](docs/deploy.md).

## Ограничения

- Нет CRDT/OT: одновременное редактирование одного объекта не поддерживается.
- Штрихи нельзя перемещать, масштабировать или поворачивать.
- Нет чата, записи урока и домашних заданий.
- Konva подключается с CDN; для закрытого контура файл нужно положить в `frontend/vendor/`.
- SQLite подходит для одного-двух инстансов; при большем масштабе нужен Postgres.
