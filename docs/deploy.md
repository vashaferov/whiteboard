# Деплой онлайн-доски

Если на VDS уже работают другие контейнеры за общим reverse proxy, используйте
изолированную схему из [deploy-vds.md](deploy-vds.md): она не занимает 80/443 и
не трогает чужие сервисы.

Схема production-стека:

```
Интернет → Caddy (443, TLS) → whiteboard (8000, N инстансов)
                               ├─ Redis      — общее состояние комнат и Pub/Sub
                               ├─ SeaweedFS  — изображения (S3 API)
                               └─ SQLite     — холодные снимки комнат (том)
```

Caddy автоматически получает и обновляет TLS-сертификат, проксирует WebSocket и
закрывает наружу только 80/443. SeaweedFS и Redis не публикуются.

SeaweedFS выбран как S3-совместимое хранилище: MinIO больше не публикует
бесплатные образы в Docker Hub. Приложение работает с любым S3 API, поэтому
замена на AWS S3 или Yandex Object Storage — это только настройки `S3_*`.

## 1. Подготовка сервера

- Linux-сервер с Docker Engine 27+ и Compose v2, 2 ГБ RAM (для двух инстансов — 4 ГБ).
- DNS: A/AAAA-запись домена указывает на сервер. Порты 80 и 443 открыты.
- Домен для доски, например `board.example.com`.

## 2. Конфигурация

```bash
git clone <repo> whiteboard && cd whiteboard
cp .env.example .env
```

Обязательно поменяйте в `.env`:

| Переменная | Значение |
|---|---|
| `ADMIN_PASSWORD` | надёжный пароль bootstrap-администратора (или смените его в админке) |
| `COOKIE_SECURE` | `true` (сессионная cookie только по HTTPS; в prod-compose так по умолчанию) |
| `SESSION_TTL_HOURS` | `12` (время жизни сессии) |
| `DOMAIN` | ваш домен (для Caddy и публичных URL) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | ключи SeaweedFS (или внешнего S3), не значения по умолчанию |
| `SENTRY_DSN` | DSN проекта Sentry (необязательно) |
| `LOG_JSON` | `true` (уже задан в compose) |

Публичный адрес изображений задаётся переменной `S3_PUBLIC_BASE_URL`; по умолчанию
это `https://<DOMAIN>/media`, и Caddy проксирует `/media/*` в bucket SeaweedFS.
Имя bucket берётся из `S3_BUCKET` (по умолчанию `whiteboard`); то же значение
подставляется в Caddyfile (`{$S3_BUCKET:whiteboard}`) и в конфиг SeaweedFS,
поэтому менять bucket нужно только в одном месте — `.env`.

Приложение по умолчанию **не** выставляет ACL `public-read` (`S3_PUBLIC_READ=false`).
Публичное чтение в compose обеспечивает identity `anonymous` с действием `Read`
в конфиге SeaweedFS (`/tmp/s3.json`, генерируется из `S3_ACCESS_KEY` и
`S3_SECRET_KEY` при старте контейнера). Запись и создание bucket доступны только
по ключам приложения.

Для внешнего S3 (AWS, Yandex Object Storage) уберите сервис `s3` из
`docker-compose.prod.yml`, направьте Caddy `/media/*` на внешний endpoint (или
используйте публичный URL провайдера) и задайте `S3_ENDPOINT_URL`, `S3_BUCKET`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_PUBLIC_BASE_URL`. Bucket должен
разрешать анонимное чтение: настройте bucket policy (`s3:GetObject` для `*`) либо,
если провайдер поддерживает ACL, включите `S3_PUBLIC_READ=true`.

## 3. Запуск

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Проверка:

```bash
curl -fsS https://board.example.com/health
curl -fsS https://board.example.com/health/ready
curl -fsS https://board.example.com/metrics | head
```

`/health/ready` возвращает 503, если недоступны SQLite, хранилище изображений или
Redis. Caddy не отправляет трафик в нездоровый инстанс.

Для локальной проверки без домена:

```bash
DOMAIN=localhost docker compose -f docker-compose.prod.yml up -d --build
# https://localhost — Caddy использует внутренний CA; браузер попросит довериться ему
```

## 4. Масштабирование

Состояние комнат и presence хранятся в Redis, события идут через Pub/Sub, поэтому
можно запустить несколько инстансов:

```bash
docker compose -f docker-compose.prod.yml up -d --scale whiteboard=2
```

Caddy сам балансирует запросы между IP-адресами сервиса `whiteboard`. WebSocket
одного клиента живёт на одном инстансе; остальные получают события через Redis.
SQLite остаётся холодным хранилищем снимков — общий том `whiteboard-data`
смонтирован во все инстансы. Если том сетевой и SQLite вызывает блокировки,
перейдите на Postgres (следующий шаг) или оставьте один инстанс.

Без `REDIS_URL` приложение работает в одиночном in-memory режиме — это допустимо
для разработки и небольших уроков.

## 5. Обновление и откат

```bash
docker compose -f docker-compose.prod.yml build whiteboard
docker compose -f docker-compose.prod.yml up -d --no-deps whiteboard
```

Uvicorn получает SIGTERM и корректно закрывает WebSocket-соединения
(`--timeout-graceful-shutdown 20`). Для отката переключитесь на предыдущий
git-тег и повторите сборку.

## 6. Бэкапы

В production SQLite и загрузки лежат в named volumes, поэтому бэкап запускается
в одноразовом контейнере с теми же томами:

```bash
mkdir -p backups
docker run --rm \
  -v whiteboard_whiteboard-data:/data:ro \
  -v whiteboard_whiteboard-uploads:/uploads:ro \
  -v "$PWD/backups:/backups" \
  -v "$PWD/scripts:/scripts:ro" \
  python:3.13-slim python /scripts/backup.py \
    --db /data/whiteboard.db --uploads /uploads --out-dir /backups --keep 14
```

Имена томов начинаются с имени compose-проекта (обычно `whiteboard_`);
проверьте их командой `docker volume ls`. В каталоге бэкапа: `whiteboard.db`
(согласованный снимок через SQLite backup API), `uploads.zip` и `manifest.json`.
Скопируйте `backups/` на внешнее хранилище (`rclone`, S3, restic).

Ежедневный запуск (cron):

```cron
0 3 * * * cd /opt/whiteboard && ./scripts/backup-docker.sh >> /var/log/whiteboard-backup.log 2>&1
```

Восстановление:

```bash
docker compose -f docker-compose.prod.yml stop whiteboard

docker run --rm \
  -v whiteboard_whiteboard-data:/data \
  -v "$PWD/backups/<timestamp>:/backup:ro" \
  python:3.13-slim sh -c "cp /backup/whiteboard.db /data/whiteboard.db"

docker run --rm \
  -v whiteboard_whiteboard-uploads:/uploads \
  -v "$PWD/backups/<timestamp>:/backup:ro" \
  python:3.13-slim sh -c "rm -rf /uploads/* && cd /uploads && python -m zipfile -e /backup/uploads.zip ."

docker compose -f docker-compose.prod.yml start whiteboard
```

При локальном запуске (bind mount `./data` и `./uploads`) достаточно
`python scripts/backup.py --keep 14`.

Изображения при `S3_BUCKET` лежат не в `uploads`, а в томе `s3-data` (SeaweedFS).
Бэкапьте его snapshot диска либо используйте внешний S3 с версионированием:
`uploads.zip` в этом режиме почти пуст.

## 7. Наблюдаемость

- **Prometheus**: `GET /metrics`. Основные метрики: `whiteboard_rooms`,
  `whiteboard_users`, `whiteboard_ws_connections`,
  `whiteboard_ws_messages_total`, `whiteboard_ws_errors_total`,
  `whiteboard_http_requests_total`, `whiteboard_http_request_duration_seconds`,
  `whiteboard_upload_bytes_total`.
- **Логи**: JSON в stdout (`LOG_JSON=true`), поле `request_id`; клиент может
  передать `X-Request-ID`, ответ содержит тот же заголовок. `docker compose logs -f whiteboard`.
- **Sentry**: задайте `SENTRY_DSN`; ошибки и исключения уходят автоматически,
  `SENTRY_TRACES_SAMPLE_RATE` управляет трейсингом (0 — выключен).
- **Healthcheck**: Docker проверяет `/health/ready` каждые 30 секунд.

Пример scrape-конфига Prometheus:

```yaml
scrape_configs:
  - job_name: whiteboard
    metrics_path: /metrics
    static_configs:
      - targets: ["board.example.com"]
```

## 8. Чек-лист приёмки

1. `https://<DOMAIN>` открывается, сертификат валиден.
2. Учитель входит по коду, ученик — по ссылке; оба видят рисунки и курсоры.
3. Изображение загружается и отображается у обоих (URL ведёт на `/media/...`).
4. `/health/ready` — 200, `/metrics` отдаёт метрики.
5. `docker compose stop whiteboard` не рвёт данные: после старта комната
   восстанавливается из снимка.
6. Бэкап создаётся и восстанавливается по инструкции выше.
