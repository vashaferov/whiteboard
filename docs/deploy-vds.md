# Деплой на VDS рядом с существующими контейнерами

Сценарий: на VDS уже работают другие сервисы за общим reverse proxy (nginx,
Caddy или Traefik), и их нельзя трогать. Доска разворачивается отдельным
compose-проектом `whiteboard-prod`:

```
Интернет → существующий reverse proxy (TLS) → 127.0.0.1:8010 → whiteboard
                                                                 ├─ redis (внутренняя сеть)
                                                                 └─ тома data/uploads
```

- Новые контейнеры: `whiteboard-prod-whiteboard-1`, `whiteboard-prod-redis-1`.
- Свои тома: `whiteboard-prod_whiteboard-data`, `_whiteboard-uploads`, `_redis-data`.
- Порты 80/443 не занимаются; приложение слушает только `127.0.0.1`.
- Картинки хранятся в томе `uploads` и отдаются самим приложением по `/uploads`,
  поэтому отдельный S3/SeaweedFS и маршрут `/media` не нужны.
- Чужие контейнеры, сети и тома не изменяются: все команды идут с
  `-p whiteboard-prod -f docker-compose.vds.yml`.

Полный «отдельный сервер с Caddy и SeaweedFS» описан в `docs/deploy.md`.

## 1. Один раз на сервере

Создать отдельного пользователя (или использовать существующего) с доступом к
Docker и SSH-ключом:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# публичный ключ из шага 2:
sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys < deploy_key.pub

sudo mkdir -p /opt/whiteboard
sudo chown deploy:deploy /opt/whiteboard
sudo -u deploy git clone <repo-url> /opt/whiteboard
```

Проверить, что Docker и Compose доступны без sudo:

```bash
docker version
docker compose version
```

Создать `/opt/whiteboard/.env` из `.env.example` и заполнить:

| Переменная | Значение |
|---|---|
| `ADMIN_PASSWORD` | надёжный пароль bootstrap-администратора |
| `COOKIE_SECURE` | `true` (прокси отдаёт HTTPS) |
| `GHCR_OWNER` | GitHub-владелец пакета (логин/организация, в нижнем регистре) |
| `GHCR_REPO` | имя репозитория/пакета, например `whiteboard` |
| `WB_TAG` | `latest` (workflow переопределяет тегом коммита) |
| `WB_PORT` | свободный loopback-порт, например `8010` |
| `S3_BUCKET` | пусто — локальные uploads |
| `SENTRY_DSN` | необязательно |

Права на файл: `chmod 600 .env`.

## 2. SSH-ключ для GitHub Actions

Пара ключей создаётся локально (приватная часть остаётся у вас и попадает в
GitHub Secrets, публичная — на сервер):

```bash
ssh-keygen -t ed25519 -C "whiteboard-deploy" -f ~/.ssh/whiteboard_deploy_ed25519 -N ""
cat ~/.ssh/whiteboard_deploy_ed25519.pub   # добавить в authorized_keys
```

Проверка входа:

```bash
ssh -i ~/.ssh/whiteboard_deploy_ed25519 deploy@<VDS_HOST> "docker ps --format '{{.Names}}'"
```

## 3. Маршрут в существующем reverse proxy

Добавляется **только новый vhost**; конфиги существующих сервисов не меняются.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name board.example.com;

    # ssl_certificate ...; ssl_certificate_key ...;  # как у остальных сайтов

    location / {
        proxy_pass http://127.0.0.1:8010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 10m;
    }
}
```

Caddy (в отдельном файле/блоке существующего Caddy):

```caddyfile
board.example.com {
    reverse_proxy 127.0.0.1:8010
}
```

WebSocket проксируется этими настройками автоматически; отдельный маршрут не нужен.

## 4. Первый запуск

Первый запуск собирает образ на сервере (до первого деплоя из Actions):

```bash
cd /opt/whiteboard
docker compose -p whiteboard-prod -f docker-compose.vds.yml up -d --build
docker compose -p whiteboard-prod -f docker-compose.vds.yml ps
```

Проверка:

```bash
curl -fsS http://127.0.0.1:8010/health/ready
curl -fsS https://board.example.com/health
curl -fsS https://board.example.com/metrics | head
```

Открыть доску, войти администратором, сменить пароль, назначить учителя.

## 5. GitHub Actions

В репозитории уже есть `.github/workflows/ci.yml`: после успешных `test` и
`e2e` на push в `main` он собирает образ, публикует его в GHCR и вызывает
`scripts/deploy.sh` по SSH.

Секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Обязателен | Значение |
|---|---|---|
| `VDS_HOST` | да | IP или домен VDS |
| `VDS_USER` | да | `deploy` |
| `VDS_SSH_KEY` | да | содержимое приватного ключа `whiteboard_deploy_ed25519` |
| `VDS_PORT` | нет | SSH-порт, по умолчанию 22 |
| `VDS_PATH` | нет | каталог проекта, по умолчанию `/opt/whiteboard` |
| `GHCR_USER` | для приватного пакета | GitHub-логин |
| `GHCR_TOKEN` | для приватного пакета | PAT с правом `read:packages` |
| `PUBLIC_HEALTH_URL` | нет | например `https://board.example.com/health/ready` |

Рекомендуется создать Environment `production` и включить required reviewers.

Первый деплой: запушить `main`. Workflow:

1. прогоняет backend- и E2E-тесты;
2. собирает `ghcr.io/<owner>/<repo>:<commit-sha>` и `:latest`;
3. по SSH заходит на сервер, обновляет checkout (`git fetch/reset`), логинится
   в GHCR при наличии токена, делает `pull`, `up -d --no-build --remove-orphans`;
4. ждёт статус `healthy` контейнера (и публичный URL, если задан);
5. удаляет только свои dangling-образы по label проекта.

## 6. Обновление и откат

Обычное обновление — push в `main`.

Откат на предыдущий образ:

```bash
cd /opt/whiteboard
WB_TAG=<previous-sha> ./scripts/deploy.sh
```

Список доступных тегов: GitHub → Packages → `whiteboard`, либо
`docker image ls ghcr.io/<owner>/<repo>`.

Ручной деплой текущего `latest`:

```bash
cd /opt/whiteboard
./scripts/deploy.sh
```

## 7. Бэкапы

Данные лежат в томах проекта `whiteboard-prod`. Бэкап (SQLite + uploads):

```bash
cd /opt/whiteboard
COMPOSE_PROJECT_NAME=whiteboard-prod ./scripts/backup-docker.sh
```

Cron:

```cron
0 3 * * * cd /opt/whiteboard && COMPOSE_PROJECT_NAME=whiteboard-prod ./scripts/backup-docker.sh >> /var/log/whiteboard-backup.log 2>&1
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
- Если пакет GHCR приватный, сервер должен быть залогинен (`GHCR_TOKEN`);
  `GITHUB_TOKEN` работает только внутри Actions.
- TLS и заголовки `X-Forwarded-Proto` обеспечивает существующий прокси;
  приложение запускается с `--proxy-headers`.
