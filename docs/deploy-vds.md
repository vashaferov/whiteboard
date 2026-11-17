# Деплой на VDS рядом с существующими контейнерами

Сценарий: на VDS уже работают другие сервисы (nginx-certbot на 80/443,
Portainer и т. д.), и их нельзя трогать. Доска разворачивается отдельным
compose-проектом `whiteboard-prod` и публикуется на **отдельном TLS-порту
8443** того же домена:

```
Интернет → mediahlg.ru:8443 → edge (Caddy, TLS) → whiteboard:8000
                                                    ├─ redis (внутренняя сеть)
                                                    └─ тома data/uploads
```

- Новые контейнеры: `whiteboard-prod-edge-1`, `whiteboard-prod-whiteboard-1`,
  `whiteboard-prod-redis-1`.
- Свои тома: `whiteboard-prod_whiteboard-data`, `_whiteboard-uploads`,
  `_redis-data`, `_edge-data`, `_edge-config`.
- Порты 80/443 не занимаются и существующий reverse proxy не изменяется.
- TLS-сертификат `mediahlg.ru` выпускается отдельным certbot в нашем проекте:
  ACME-челлендж пишется в webroot существующего nginx (порт 80), а сам
  сертификат хранится в `TLS_CERTS_DIR`. Certbot-состояние существующего
  nginx не изменяется.
- Приложение слушает `127.0.0.1:8010` (диагностика/health), наружу его отдаёт
  `edge` на `8443`.
- Картинки хранятся в томе `uploads` и отдаются приложением по `/uploads`,
  поэтому отдельный S3/SeaweedFS и маршрут `/media` не нужны.
- Все команды идут с `-p whiteboard-prod -f docker-compose.vds.yml`; чужие
  контейнеры, сети и тома не изменяются.

Полный «отдельный сервер с Caddy и SeaweedFS» описан в `docs/deploy.md`.

## 1. Один раз на сервере

Пользователь деплоя уже состоит в группе `docker`; `sudo` не требуется.
Каталог проекта — в домашнем каталоге, потому что `/opt` принадлежит root:

```bash
git clone https://github.com/vashaferov/whiteboard.git ~/whiteboard
cd ~/whiteboard
```

Создать `~/whiteboard/.env` из `.env.example` и заполнить:

| Переменная | Значение |
|---|---|
| `ADMIN_PASSWORD` | надёжный пароль bootstrap-администратора |
| `COOKIE_SECURE` | `true` |
| `DOMAIN` | `mediahlg.ru` |
| `WB_HTTPS_PORT` | `8443` |
| `TLS_CERTS_DIR` | `/home/vashaferov/whiteboard-certs` (собственное хранилище сертификата) |
| `CERTBOT_EMAIL` | email для Let's Encrypt |
| `CERTBOT_WEBROOT` | `/home/vashaferov/duty/certbot-www` (webroot существующего nginx) |
| `GHCR_OWNER` | `vashaferov` |
| `GHCR_REPO` | `whiteboard` |
| `WB_TAG` | `latest` (workflow переопределяет тегом коммита) |
| `WB_PORT` | `8010` |
| `S3_BUCKET` | пусто — локальные uploads |
| `SENTRY_DSN` | необязательно |

Права на файл: `chmod 600 .env`.

Проверить, что существующий nginx отдаёт ACME-челленджи (dry-run, не меняет
сертификаты):

```bash
docker run --rm \
  -v /home/vashaferov/whiteboard-certs:/etc/letsencrypt \
  -v /home/vashaferov/duty/certbot-www:/var/www/certbot \
  certbot/certbot renew --dry-run --webroot -w /var/www/certbot
```

Порт `8443` должен быть свободен и открыт в firewall/панели провайдера:

```bash
ss -lnt | grep ':8443 ' || true
```

## 2. SSH-ключ для GitHub Actions

Пара ключей создаётся локально (приватная часть остаётся у вас и попадает в
GitHub Secrets, публичная — на сервер):

```bash
ssh-keygen -t ed25519 -C "whiteboard-deploy" -f ~/.ssh/whiteboard_deploy_ed25519 -N ""
cat ~/.ssh/whiteboard_deploy_ed25519.pub   # добавить в authorized_keys
```

Проверка входа:

```bash
ssh -i ~/.ssh/whiteboard_deploy_ed25519 vashaferov@<VDS_HOST> "docker ps --format '{{.Names}}'"
```

## 3. TLS на 8443

`deploy/Caddyfile.edge`:

```caddyfile
{
    auto_https off
    admin 127.0.0.1:2019
}

{$DOMAIN}:{$HTTPS_PORT} {
    tls /certs/live/{$DOMAIN}/fullchain.pem /certs/live/{$DOMAIN}/privkey.pem
    encode zstd gzip
    reverse_proxy whiteboard:8000
}
```

Особенности:

- `auto_https off` — Caddy не пытается получить сертификат через 80/443.
- `TLS_CERTS_DIR` монтируется в `/certs:ro`; Caddy читает файлы как root.
- Caddy сам проксирует WebSocket и передаёт `Host: mediahlg.ru:8443`, поэтому
  проверка same-origin в приложении проходит.
- Первичный выпуск сертификата:

  ```bash
  cd ~/whiteboard
  ./scripts/certbot.sh init
  ```

  Скрипт использует webroot существующего nginx на порту 80 (`CERTBOT_WEBROOT`),
  а сертификат складывает в `TLS_CERTS_DIR`. Состояние чужого certbot не меняется.
- Автоматическое продление и перечитывание сертификата:

  ```cron
  30 3 * * * cd /home/vashaferov/whiteboard && ./scripts/certbot.sh renew >> /home/vashaferov/whiteboard-certs-log/renew.log 2>&1
  15 4 * * * cd /home/vashaferov/whiteboard && ./scripts/reload-edge.sh >> /home/vashaferov/whiteboard-certs-log/reload-edge.log 2>&1
  ```

  `certbot renew` продлевает сертификат только когда до истечения остаётся
  меньше 30 дней, затем скрипт сам делает `caddy reload`. Ежедневный reload —
  страховка на случай ручного продления.

Если позже понадобится отдавать доску на 443 через существующий nginx,
достаточно нового vhost с `proxy_pass http://127.0.0.1:8010` (Host с портом
передавать не нужно) и открытия сертификата для нового имени; текущая схема
этого не требует.

## 4. Первый запуск

До первого деплоя из Actions образ можно собрать на сервере:

```bash
cd ~/whiteboard
docker compose -p whiteboard-prod -f docker-compose.vds.yml up -d --build
docker compose -p whiteboard-prod -f docker-compose.vds.yml ps
```

Проверка:

```bash
curl -fsS http://127.0.0.1:8010/health/ready
curl -fsS https://mediahlg.ru:8443/health
curl -fsS https://mediahlg.ru:8443/metrics | head
```

Открыть `https://mediahlg.ru:8443`, войти администратором, сменить пароль,
назначить учителя.

## 5. GitHub Actions

В репозитории есть `.github/workflows/ci.yml`: после успешных `test` и `e2e`
на push в `main` он собирает образ, публикует его в GHCR и вызывает
`scripts/deploy.sh` по SSH.

Секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Обязателен | Значение |
|---|---|---|
| `VDS_HOST` | да | `mediahlg.ru` или IP |
| `VDS_USER` | да | `vashaferov` |
| `VDS_SSH_KEY` | да | содержимое приватного ключа `whiteboard_deploy_ed25519` |
| `VDS_PORT` | нет | SSH-порт, по умолчанию 22 |
| `VDS_PATH` | да для этой схемы | `/home/vashaferov/whiteboard` |
| `GHCR_USER` | для приватного пакета | GitHub-логин |
| `GHCR_TOKEN` | для приватного пакета | PAT с правом `read:packages` |
| `PUBLIC_HEALTH_URL` | рекомендуется | `https://mediahlg.ru:8443/health/ready` |

Рекомендуется создать Environment `production` и включить required reviewers.
Пока сервер не готов, деплой выключен: создайте repository variable
`DEPLOY_ENABLED = true` (Settings → Secrets and variables → Actions → Variables),
когда секреты добавлены. Сборка образа при этом работает всегда.

Что делает деплой:

1. backend- и E2E-тесты на GitHub;
2. сборка `ghcr.io/<owner>/<repo>:<commit-sha>` и `:latest`;
3. SSH на сервер: `git fetch/reset`, логин в GHCR при наличии токена,
   `pull`, `up -d --no-build --remove-orphans`;
4. ожидание `healthy` у `whiteboard` и `edge`, перечитывание сертификата;
5. проверка `PUBLIC_HEALTH_URL`, если задан;
6. удаление только своих dangling-образов по label проекта.

## 6. Обновление и откат

Обычное обновление — push в `main`.

Откат на предыдущий образ:

```bash
cd ~/whiteboard
WB_TAG=<previous-sha> ./scripts/deploy.sh
```

Список тегов: GitHub → Packages → `whiteboard`, либо
`docker image ls ghcr.io/<owner>/<repo>`.

Ручной деплой текущего `latest`:

```bash
cd ~/whiteboard
./scripts/deploy.sh
```

Скрипт сам делает `git fetch/reset` и перезапускается уже новой версией.

## 7. Бэкапы

Данные лежат в томах проекта `whiteboard-prod`. Бэкап (SQLite + uploads):

```bash
cd ~/whiteboard
COMPOSE_PROJECT_NAME=whiteboard-prod ./scripts/backup-docker.sh
```

Cron:

```cron
0 3 * * * cd /home/vashaferov/whiteboard && COMPOSE_PROJECT_NAME=whiteboard-prod ./scripts/backup-docker.sh >> /var/log/whiteboard-backup.log 2>&1
```

Каталог `backups/` выгружайте на внешнее хранилище (`rclone`, S3, restic).
Восстановление — см. `docs/deploy.md`, раздел «Бэкапы», с теми же именами томов
`whiteboard-prod_whiteboard-data` и `whiteboard-prod_whiteboard-uploads`.

## 8. Ограничения

- Пока используется SQLite, держите **один** контейнер `whiteboard`; не
  запускайте `--scale`.
- Никогда не выполняйте `docker compose down -v` для этого проекта — удалятся
  тома с данными.
- Не используйте глобальный `docker system prune`: он затрагивает чужие образы.
- Пароль из `ADMIN_PASSWORD` действует при первом создании администратора;
  дальше меняйте его в админке.
- Если пакет GHCR приватный, сервер логинится по `GHCR_TOKEN`; `GITHUB_TOKEN`
  работает только внутри Actions.
- Сертификат продлевает собственный `scripts/certbot.sh renew` (cron);
  `edge` перечитывает его сразу после продления и дополнительно ежедневно
  через `scripts/reload-edge.sh`.
