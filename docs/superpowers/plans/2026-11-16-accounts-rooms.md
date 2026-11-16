# Учётные записи, роли и комнаты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить анонимный вход по коду учителя на полноценные УЗ с ролями, подтверждением
администратором и комнатами, закреплёнными за учителем.

**Architecture:** УЗ, комнаты, доступы и серверные сессии живут в том же SQLite-файле
(`AccountStore`); REST и WS авторизуются HttpOnly-cookie `wb_session`; права проверяются в
БД при каждом запросе и подключении; выдача/отзыв доступа и блокировка действуют мгновенно
через существующий механизм kick/RoomManager.

**Tech Stack:** Python 3.13, FastAPI, сырой SQLite, bcrypt, Redis (опционально), ванильный
JS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-accounts-rooms-design.md`

## Global Constraints

- Роли: только `student`, `teacher`, `admin`. Статусы: `pending`, `active`, `blocked`,
  `rejected`. Стартовый администратор создаётся при запуске; администратора нельзя
  заблокировать, понизить или удалить (400).
- Логин: `^[A-Za-z0-9_.-]{3,32}$`, уникален без учёта регистра, нормализуется `trim+lower`.
- Пароль: 8…72 байта, bcrypt (`PASSWORD_ROUNDS`, по умолчанию 12; тесты — 4), никогда не логируется.
- Cookie: имя `wb_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` из `COOKIE_SECURE`,
  TTL `SESSION_TTL_HOURS` (12), фиксированный (без продления).
- Комната: id `r_<16 hex>`, генерирует сервер; имя 1…80 после `trim`; владелец — учитель/админ.
- Доступ к комнате: `admin` ИЛИ (`owner` И роль `teacher`) ИЛИ запись `room_access` у
  активного пользователя. Анонимного входа и неявного создания комнат нет.
- Токенов в URL/localStorage/sessionStorage нет. Сессия — только cookie.
- Ошибки API: `{detail: {code: str, message: str}}`; коды: `login_taken`,
  `invalid_credentials`, `pending`, `rejected`, `blocked`, `forbidden`, `not_found`,
  `invalid_user`, `invalid_message`, `last_admin`, `rate_limited`, `bad_origin`.
- WS-коды закрытия: `4401` нет/просрочена сессия, `4403` нет доступа или выкинут, `4404`
  комната не найдена; `4400` некорректный id комнаты.
- Старые снимки и Redis-ключи комнат удаляются один раз по маркеру `app_meta['accounts_v1']`.
- Нагрузочный тест `scripts/load_test.py` удаляется вместе с упоминаниями.
- Backend-проверки: из `backend` — `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`,
  `ruff check .`, `black --check .`. E2E: из `e2e` —
  `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.
- Промежуточные legacy-ветки (старый `POST /api/login` по имени/роли/коду и WS `?token=`)
  существуют только до Task 7 и там удаляются. Финальный код без JWT.

## Review Focus

1. Просроченная или удалённая сессия при открытой доске: WS-реконнект получает 4401, клиент
   уходит на экран входа, а не зависает в «Переподключение…». Тест — Task 11.
2. Отзыв доступа, блокировка, смена роли и удаление комнаты, пока ученик внутри: выкидывает
   сразу и не даёт переподключиться. Тесты — Task 6 (WS), Task 4/5 (REST), Task 12 (E2E).
3. Чужой `Origin` у изменяющих запросов: регистрация, вход, комнаты, админка → 403. Тест — Task 3.
4. Логин в другом регистре, повторная заявка после отказа, вход до подтверждения и после
   блокировки: понятные ошибки, без утечки пароля/хеша. Тест — Task 3.
5. Одновременные действия администратора и учителя: повышение/понижение/блокировка во время
   подключения не оставляют старую роль в комнате. Тесты — Task 5 (REST/manager), Task 12 (E2E).

---

### Task 1: Хранилище УЗ и сессий

**Files:**
- Create: `backend/app/services/accounts.py`
- Modify: `backend/app/services/auth.py` (только добавления; JWT остаётся до Task 7)
- Modify: `backend/requirements.txt`
- Test: `backend/tests/test_accounts_store.py`

**Interfaces:**
- Produces (для всех следующих задач):

```python
class LoginTakenError(Exception): ...

@dataclass(frozen=True, slots=True)
class User:
    id: str; login: str; name: str; role: str; status: str; color: str; created_at: str

class AccountStore:
    def __init__(self, path: Path) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> bool: ...
    async def create_user(self, *, login: str, name: str, password_hash: str,
                          role: str = "student", status: str = "pending",
                          user_id: str | None = None) -> User: ...
    async def get_user(self, user_id: str) -> User | None: ...
    async def get_user_by_login(self, login: str) -> User | None: ...
    async def get_user_with_hash(self, login: str) -> tuple[User, str] | None: ...
    async def list_users(self, *, status: str | None = None, role: str | None = None,
                         query: str | None = None, limit: int = 500) -> list[User]: ...
    async def update_user(self, user_id: str, *, status: str | None = None,
                          role: str | None = None) -> User | None: ...
    async def set_password(self, user_id: str, password_hash: str) -> bool: ...
    async def ensure_admin(self, *, login: str, name: str,
                           password_hash: str) -> User | None: ...
    async def create_session(self, user_id: str, ttl_seconds: int) -> str: ...
    async def get_session_user(self, session_id: str) -> User | None: ...
    async def delete_session(self, session_id: str) -> None: ...
    async def delete_user_sessions(self, user_id: str) -> None: ...
    async def prune_sessions(self) -> int: ...

SESSION_COOKIE = "wb_session"
def hash_password(password: str, rounds: int) -> str: ...
def verify_password(password: str, password_hash: str) -> bool: ...
def normalize_login(login: str) -> str: ...
def new_session_id() -> str: ...
def is_staff(role: str) -> bool: ...        # teacher или admin
class WindowLimiter:
    def __init__(self, limit: int, window_seconds: float) -> None: ...
    def hit(self, key: str) -> bool: ...    # False, если лимит превышен
    def reset(self, key: str) -> None: ...
```

- [ ] **Step 1: Добавить зависимость bcrypt**

Добавить в `backend/requirements.txt` строку `bcrypt>=4.2,<5.0` и выполнить
`..\.venv\Scripts\python.exe -m pip install "bcrypt>=4.2,<5.0"`.

- [ ] **Step 2: Написать падающие тесты хранилища**

`backend/tests/test_accounts_store.py` — фикстура `store = AccountStore(tmp_path / "wb.db")`:

```python
async def test_create_user_normalizes_login(store):
    user = await store.create_user(login=" Ann.A ", name="Анна",
                                   password_hash=hash_password("secret-1", 4))
    assert user.login == "Ann.A"
    assert (await store.get_user_by_login("ann.a")).id == user.id

async def test_duplicate_login_raises(store):
    await store.create_user(login="ann", name="A", password_hash="x")
    with pytest.raises(LoginTakenError):
        await store.create_user(login="ANN", name="B", password_hash="x")

async def test_session_roundtrip_and_expiry(store):
    user = await store.create_user(login="ann", name="A", password_hash="x", status="active")
    sid = await store.create_session(user.id, ttl_seconds=60)
    assert (await store.get_session_user(sid)).id == user.id
    await store.delete_session(sid)
    assert await store.get_session_user(sid) is None
    expired = await store.create_session(user.id, ttl_seconds=-1)
    assert await store.get_session_user(expired) is None
    assert await store.prune_sessions() >= 0

async def test_ensure_admin_only_once(store):
    created = await store.ensure_admin(login="root", name="Админ", password_hash="x")
    assert created.role == "admin" and created.status == "active"
    assert await store.ensure_admin(login="root2", name="Ещё", password_hash="x") is None

async def test_password_hash_roundtrip():
    digest = hash_password("long-enough", 4)
    assert verify_password("long-enough", digest)
    assert not verify_password("wrong", digest)

def test_window_limiter():
    limiter = WindowLimiter(limit=2, window_seconds=60)
    assert limiter.hit("ip") and limiter.hit("ip") and not limiter.hit("ip")
    limiter.reset("ip")
    assert limiter.hit("ip")
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_accounts_store.py -q -p no:warnings`
Expected: FAIL (ModuleNotFoundError / ImportError на `AccountStore`).

- [ ] **Step 4: Реализовать `AccountStore` и хелперы**

`accounts.py`: таблицы `users` и `sessions` из спеки (раздел 8) плюс `app_meta`;
`_connect()` с `PRAGMA foreign_keys=ON`, `journal_mode=WAL`; все методы через
`asyncio.to_thread`. `create_user` без `user_id` генерирует `u_<uuid4().hex[:16]>` и
`color = pick_color(user_id)`. `get_user_with_hash` делает JOIN/отдельный SELECT по
`login_norm`. `ensure_admin` в одной транзакции проверяет `COUNT(*) WHERE role='admin'` и
вставляет. `hash_password(password, rounds)` — `bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds))`;
`verify_password` ловит `ValueError` и возвращает False. `WindowLimiter` хранит deque
таймстемпов на ключ.

- [ ] **Step 5: Прогнать тесты и весь бэкенд**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_accounts_store.py -q -p no:warnings`
Expected: PASS.
Run: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
Expected: PASS (старый код не тронут).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/accounts.py backend/app/services/auth.py \
        backend/requirements.txt backend/tests/test_accounts_store.py
git commit -m "feat: add account and session store"
```

---

### Task 2: Комнаты, доступ и чистый старт

**Files:**
- Modify: `backend/app/services/accounts.py`
- Create: `backend/app/services/access.py`
- Modify: `backend/app/services/storage.py` (метод `delete`)
- Modify: `backend/app/services/room_manager.py` (`purge_room_keys`)
- Test: `backend/tests/test_rooms_store.py`, `backend/tests/test_access.py`,
  `backend/tests/test_storage.py` (дополнить), `backend/tests/test_accounts_store.py` (дополнить)

**Interfaces:**
- Consumes: `AccountStore`, `User` из Task 1.
- Produces:

```python
@dataclass(frozen=True, slots=True)
class Room:
    id: str; name: str; owner_id: str; owner_name: str; created_at: str

async def create_room(self, *, owner_id: str, name: str, room_id: str | None = None) -> Room
async def get_room(self, room_id: str) -> Room | None
async def list_owned_rooms(self, owner_id: str) -> list[Room]
async def list_rooms_for_student(self, user_id: str) -> list[Room]
async def list_all_rooms(self) -> list[Room]
async def rename_room(self, room_id: str, name: str) -> Room | None
async def delete_room(self, room_id: str) -> bool
async def list_room_ids(self) -> list[str]
async def list_room_access(self, room_id: str) -> list[User]
async def set_room_access(self, room_id: str, user_ids: list[str],
                          granted_by: str) -> tuple[list[User], set[str], set[str]]
async def has_room_access(self, room_id: str, user_id: str) -> bool
async def list_active_students(self, query: str | None = None, limit: int = 50) -> list[User]
# AccountStore.legacy_wiped: bool — True, если при инициализации удалили старые снимки

def can_access_room(user: User, room: Room, *, granted: bool) -> bool
# SnapshotStore.delete(self, room_id: str) -> None
# RoomManager.purge_room_keys(self) -> int   # SCAN/DELETE "<prefix>:room:*"
```

- [ ] **Step 1: Написать падающие тесты**

`test_rooms_store.py`: создание/получение комнаты с явным `room_id="r_test"`, порядок списков,
`rename_room`, `delete_room` удаляет и доступы, `set_room_access` возвращает `(current, added,
removed)`, `has_room_access`, `list_rooms_for_student`, `list_active_students(query="ан")`
(ищет по имени и логину, только `active` + `student`, лимит).

`test_access.py` — матрица:

```python
@pytest.mark.parametrize(
    ("role", "is_owner", "granted", "expected"),
    [("admin", False, False, True), ("teacher", True, False, True),
     ("teacher", False, True, True), ("student", True, False, False),
     ("student", False, True, True), ("student", False, False, False)],
)
def test_can_access_room(role, is_owner, granted, expected):
    user = make_user(role=role)
    room = make_room(owner_id=user.id if is_owner else "u_other")
    assert can_access_room(user, room, granted=granted) is expected
```

`test_storage.py`: после `save(...)` — `await store.delete("room-1")`, `load` → None.

`test_accounts_store.py`: миграция — создать `SnapshotStore(tmp_path/"wb.db")`, сохранить
снимок комнаты, затем `AccountStore(тот же путь)`: `legacy_wiped is True`, снимок удалён, маркер
записан; второй `AccountStore` — `legacy_wiped is False`, данные не трогаются.

`test_redis.py` (или новый `test_room_close.py`): `purge_room_keys` удаляет ключи
`<prefix>:room:*`, оставляя чужие.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_rooms_store.py tests/test_access.py -q -p no:warnings`
Expected: FAIL (нет методов/модулей).

- [ ] **Step 3: Реализовать**

Таблицы `rooms`, `room_access` из спеки; списки комнат с JOIN владельца; `set_room_access`
в одной транзакции вычисляет добавленных/убранных по `userIds` (валидация id на уровне API);
`list_room_ids`; `legacy_wiped` — в `_init_db` при отсутствии маркера: проверить
`sqlite_master`, `DELETE FROM room_snapshots`, вставить `accounts_v1`, выставить флаг.
`access.py` — правило из Global Constraints. `purge_room_keys` — `scan_iter(match=...)` +
`delete`.

- [ ] **Step 4: Прогнать новые тесты и весь бэкенд**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_rooms_store.py tests/test_access.py tests/test_accounts_store.py tests/test_storage.py -q -p no:warnings`
Expected: PASS. Затем полный `pytest` — PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services backend/tests
git commit -m "feat: add owned rooms, access grants and legacy wipe"
```

---

### Task 3: Cookie-аутентификация (регистрация, вход, выход, /me)

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/api/deps.py`
- Create: `backend/app/api/accounts.py`
- Delete: `backend/app/api/auth.py` (старый хендлер переезжает в `accounts.py` с legacy-веткой)
- Modify: `backend/app/models/schemas.py`
- Create: `backend/app/api/errors.py`
- Test: `backend/tests/test_auth_api.py`
- Create: `backend/tests/support.py` (`cookie(session)`, `ws_connect(client, session, room)`)
- Test support: `backend/tests/conftest.py` (добавить фикстуры, не ломая старые)

**Interfaces:**
- Consumes: `AccountStore`, `User`, `hash_password`, `verify_password`, `WindowLimiter`,
  `SESSION_COOKIE`, `is_staff`.
- Produces:

```python
# config.py
admin_login: str = "admin"
admin_password: str = "admin-change-me"
admin_name: str = "Администратор"
session_ttl_hours: int = 12
cookie_secure: bool = False
password_rounds: int = 12

# api/errors.py
def api_error(status_code: int, code: str, message: str) -> HTTPException: ...

# api/deps.py
@dataclass(frozen=True, slots=True)
class AuthSession:
    user: User
    session_id: str

def get_account_store(request: Request) -> AccountStore: ...
async def get_auth_session(session: AuthSession = Depends(...)) -> AuthSession: ...  # 401
async def get_auth_user(session: AuthSession = Depends(get_auth_session)) -> User: ...
async def require_admin(user: User = Depends(get_auth_user)) -> User: ...           # 403
async def require_same_origin(request: Request) -> None: ...                        # 403

# schemas.py
class RegisterRequest(BaseModel): login: str; name: str; password: str
class Credentials(BaseModel): login: str; password: str
class Permissions(BaseModel):  # + canCreateRooms, canManageAccounts
class UserInfo(BaseModel):     # role: Literal["student","teacher","admin"]
class AuthResponse(BaseModel): user: UserInfo; permissions: Permissions; board: BoardSize
def permissions_for(role: str) -> Permissions
```

- [ ] **Step 1: Настроить Settings и тестовую поддержку**

Добавить поля из Interfaces. В `conftest.py` в `settings` задать
`admin_login="root"`, `admin_password="root-pass-1"`, `admin_name="Администратор"`,
`password_rounds=4`, `session_ttl_hours=12`, `jwt_secret`/`teacher_code` пока оставить
(удаляются в Task 7).

Создать `tests/support.py`:

```python
def cookie(session: str) -> dict[str, str]:
    return {"wb_session": session}

def ws_connect(client: TestClient, session: str, room: str = "room-1"):
    return client.websocket_connect(
        f"/ws/{room}", headers={"cookie": f"wb_session={session}"}
    )
```

В `conftest.py` — синхронные хелперы поверх REST (админ заводится в lifespan):

```python
def login_session(client, login: str, password: str) -> str:
    response = client.post("/api/login", json={"login": login, "password": password})
    assert response.status_code == 200, response.text
    return response.cookies["wb_session"]

@pytest.fixture
def admin_session(client) -> str:
    return login_session(client, "root", "root-pass-1")

@pytest.fixture
def activate_user(client):
    def _activate(login: str, *, role: str | None = None) -> None:
        accounts = client.app.state.accounts
        user = asyncio.run(accounts.get_user_by_login(login))
        assert user is not None
        asyncio.run(accounts.update_user(user.id, status="active", role=role))
    return _activate
```

`asyncio.run` здесь безопасен: `TestClient` крутит приложение в своём потоке, а store
открывает отдельные соединения SQLite. REST-путь подтверждения (`PATCH`) появится в Task 5;
до него тесты активируют УЗ через store.

- [ ] **Step 2: Написать падающие REST-тесты**

`test_auth_api.py` (использовать `client`; cookie хранится в клиенте):

```python
def test_register_creates_pending_and_login_is_forbidden(client):
    r = client.post("/api/register", json={"login": "Anna_1", "name": "Анна",
                                           "password": "secret-1"})
    assert r.status_code == 201 and r.json() == {"status": "pending"}
    r = client.post("/api/login", json={"login": "anna_1", "password": "secret-1"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "pending"

def test_duplicate_login_is_case_insensitive(client):
    body = {"login": "anna", "name": "А", "password": "secret-1"}
    assert client.post("/api/register", json=body).status_code == 201
    body["login"] = "ANNA"
    r = client.post("/api/register", json=body)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "login_taken"

def test_approve_via_store_then_login_sets_cookie(client, activate_user):
    ...  # register; activate_user("anna"); login -> 200
    response = client.post("/api/login", json={"login": "anna", "password": "secret-1"})
    set_cookie = response.headers["set-cookie"]
    assert "wb_session=" in set_cookie and "HttpOnly" in set_cookie and "SameSite=lax" in set_cookie
    assert client.get("/api/me").json()["user"]["role"] == "student"
    assert client.get("/api/me").json()["permissions"]["canManageAccounts"] is False

def test_logout_clears_session(client):
    ...  # login; assert 204; /api/me -> 401

def test_wrong_origin_is_rejected(client):
    r = client.post("/api/register", json={"login": "anna", "name": "А", "password": "secret-1"},
                    headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "bad_origin"

def test_bad_password_and_login_throttle(client, app):
    app.state.login_limiter = WindowLimiter(limit=2, window_seconds=60)
    ...  # 2 неверных пароля -> 401, третий -> 429 rate_limited

def test_admin_permissions_include_accounts():
    assert permissions_for("admin").canManageAccounts is True
    assert permissions_for("teacher").canManageAccounts is False
    assert permissions_for("student").canCreateRooms is False
```

Подтверждение через REST (`PATCH /api/admin/users/{id}`) появится в Task 5; на этом шаге
статус меняется через store, а REST-путь проверяется в `test_admin_api.py`.

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_auth_api.py -q -p no:warnings`
Expected: FAIL (404/500 на `/api/register`, нет cookie).

- [ ] **Step 4: Реализовать аутентификацию**

- `api/accounts.py`: роутер с `require_same_origin`; `POST /register` (валидация, хеш,
  `LoginTakenError → 409`), `POST /login`, `POST /logout`, `GET /me`.
- `POST /login` принимает **оба** формата до Task 7: если в теле есть `login` — cookie-вход
  (`get_user_with_hash`, `verify_password`, статус → 403 с кодом, сессия, `Set-Cookie`,
  ответ `AuthResponse`); иначе — legacy-вход из старого `api/auth.py` (JWT, старый
  `LoginResponse`). В коде пометить `# legacy до Task 7`.
- Cookie: `response.set_cookie(SESSION_COOKIE, sid, max_age=ttl, httponly=True,
  samesite="lax", secure=settings.cookie_secure, path="/")`; logout — `delete_cookie`.
- `get_auth_session`: cookie → `get_session_user` → статус `active` (иначе 401), 401
  `unauthenticated` без cookie. `require_same_origin`: для `POST/PATCH/DELETE/PUT` сверить
  `Origin` (или `Referer`) с `Host`; нет обоих — разрешить.
- `main.py`: `accounts = AccountStore(...)`, `await accounts.ensure_admin(...)` +
  `hash_password(settings.admin_password, settings.password_rounds)`, предупреждение при
  дефолтном пароле, `app.state.accounts`, `app.state.login_limiter = WindowLimiter(10, 60)`,
  `app.state.register_limiter = WindowLimiter(5, 60)`, включить роутер, закрыть store в
  lifespan; если `accounts.legacy_wiped` и Redis включён — `await manager.purge_room_keys()`.
- `permissions_for`: admin получает права учителя + `canManageAccounts=True`,
  `canCreateRooms` для teacher/admin.

- [ ] **Step 5: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_auth_api.py -q -p no:warnings`
Expected: PASS.
Run: полный `pytest` — PASS (legacy-вход и WS не тронуты).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api backend/app/config.py backend/app/main.py \
        backend/app/models/schemas.py backend/tests
git commit -m "feat: add cookie registration, login and sessions"
```

---

### Task 4: REST комнат и выдача доступа

**Files:**
- Create: `backend/app/api/rooms.py`
- Modify: `backend/app/main.py` (включить роутер)
- Modify: `backend/app/models/schemas.py` (`RoomCreate`, `RoomRename`, `RoomAccessUpdate`)
- Modify: `backend/app/services/room_manager.py` (`close_room`, `kick(reason=...)`)
- Test: `backend/tests/test_rooms_api.py`
- Test: `backend/tests/test_room_close.py`

**Interfaces:**
- Consumes: `AccountStore` методы Task 2, `can_access_room`, `get_auth_user`, `api_error`,
  `RoomManager.kick(room_id, user_id, *, reason=None)` и новый `close_room`.
- Produces:

```python
async def close_room(self, room_id: str, *, notify_remote: bool = False) -> None
# notify_remote=True: publish {"event": {"type": "remote_room_closed"}} и закрыть локально;
# локально: pop room, kicked "Комната удалена", close 4403, _stop_room_tasks, удалить
# Redis-ключи комнаты (objects/workspaces/seq/presence) best-effort.
async def kick(self, room_id: str, target_id: str, *,
               reason: str | None = None) -> bool  # reason уходит в kicked и remote_kick
# REST:
GET  /api/rooms                 -> list[RoomInfo]
GET  /api/rooms/all             -> list[RoomInfo]      # admin
GET  /api/rooms/{room_id}       -> RoomInfo
POST /api/rooms {name}          -> RoomInfo (201)
PATCH /api/rooms/{room_id} {name} -> 204
DELETE /api/rooms/{room_id}     -> 204
GET  /api/rooms/{room_id}/access -> list[{id,name,login}]
PUT  /api/rooms/{room_id}/access {userIds} -> list[{id,name,login}]
GET  /api/users?q=              -> list[{id,name,login}]  # teacher/admin, active students
```

`RoomInfo = {id, name, owner: {id, name}}`.

- [ ] **Step 1: Написать падающие REST-тесты**

`test_rooms_api.py` (фикстуры-хелперы из Task 3: зарегистрировать/подтвердить/войти):

```python
def test_teacher_creates_room_and_student_sees_only_granted(client, ...):
    teacher = login_session(client, teacher_login, PASSWORD)
    room = client.post("/api/rooms", json={"name": "Алгебра"},
                       cookies=cookie(teacher)).json()
    assert room["id"].startswith("r_") and room["owner"]["name"] == "Учитель"
    student = login_session(client, student_login, PASSWORD)
    assert client.get("/api/rooms", cookies=cookie(student)).json() == []
    client.put(f"/api/rooms/{room['id']}/access",
               json={"userIds": [student_user_id]}, cookies=cookie(teacher))
    rooms = client.get("/api/rooms", cookies=cookie(student)).json()
    assert [r["id"] for r in rooms] == [room["id"]]

def test_other_teacher_cannot_rename_or_delete(client):
    ...  # 403 forbidden

def test_access_replacement_returns_added_and_removed(client):
    ...  # PUT [a, b] -> [b] отдаёт список [b]; a больше не видит комнату

def test_access_rejects_inactive_user(client):
    ...  # pending/blocked id -> 400 invalid_user

def test_delete_room_frees_access_and_room(client):
    ...  # DELETE -> 204; GET /api/rooms/{id} -> 404; в store нет room_access

def test_admin_sees_all_rooms_and_can_open(client):
    ...  # GET /api/rooms/all; GET /api/rooms/{id} -> 200
```

`test_room_close.py` (manager с `fakeredis`): комната с участником; `close_room(notify_remote=True)`
→ участник получил `kicked` с «Комната удалена», сокет закрыт 4403, комната исчезла из
`manager.rooms`, Redis-ключи удалены; второй менеджер получает `remote_room_closed` и тоже
закрывает копию, не публикуя событие повторно.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_rooms_api.py tests/test_room_close.py -q -p no:warnings`
Expected: FAIL (404).

- [ ] **Step 3: Реализовать**

`api/rooms.py` с `Depends(require_same_origin)`; проверки владельца/админа через
`api_error(403, "forbidden", ...)`; комнаты студенту — `list_rooms_for_student`;
каталог — `list_active_students` (учитель/админ). При `PUT access` — каждый id проверить
через `accounts.get_user`: нет пользователя, статус не `active` или роль не `student` →
400 `invalid_user`; вычислить `removed` и для каждого вызвать
`manager.kick(room_id, user_id, reason="Учитель отменил доступ к комнате")`.
DELETE: `await manager.close_room(room_id, notify_remote=True)` →
`await accounts.delete_room(room_id)` → `await store.delete(room_id)`.
`_listen`: обработать `remote_room_closed` → `close_room(room_id)`; `remote_kick` передаёт
`reason`.

- [ ] **Step 4: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_rooms_api.py tests/test_room_close.py -q -p no:warnings`
Expected: PASS. Полный `pytest` — PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "feat: add room API with access grants"
```

---

### Task 5: Админские эндпоинты

**Files:**
- Create: `backend/app/api/admin.py`
- Modify: `backend/app/main.py` (включить роутер)
- Modify: `backend/app/models/schemas.py` (`AdminUserPatch`, `AdminPasswordReset`)
- Test: `backend/tests/test_admin_api.py`

**Interfaces:**
- Consumes: `get_auth_user`, `require_admin`, `require_same_origin` (на роутере),
  `AccountStore`, `RoomManager.kick`.
- Produces:

```python
GET   /api/admin/users?status=&role=&q= -> list[AdminUser]
PATCH /api/admin/users/{user_id} {status?, role?} -> AdminUser   # 204? нет: 200
POST  /api/admin/users/{user_id}/password {password} -> 204
# AdminUser = {id, login, name, role, status, createdAt}
```

- [ ] **Step 1: Написать падающие тесты**

```python
def test_only_admin_can_list_and_patch(client, ...):
    ...  # teacher -> 403 forbidden; admin -> 200

def test_approve_promote_block(client, ...):
    ...  # pending -> active; active -> role teacher; teacher -> blocked;
         # blocked login -> 403 blocked

def test_block_revokes_sessions(client, ...):
    ...  # войти студентом, /api/me 200; admin PATCH blocked ->
         # /api/me по старой cookie -> 401; вход -> 403 blocked
         # (kick живого WS проверяется в Task 6)

def test_password_reset_revokes_sessions(client, ...):
    ...  # сброс; старый пароль 401; новый 200; старая cookie 401

def test_admin_is_protected(client, admin):
    ...  # PATCH status/role ему самому или другому админу -> 400 last_admin
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_admin_api.py -q -p no:warnings`
Expected: FAIL (404).

- [ ] **Step 3: Реализовать**

Валидация: хотя бы одно из `status`/`role`; целевой пользователь не `admin` (400 `last_admin`);
при `status`/`role` — `delete_user_sessions`, затем для каждого `room_id` из
`accounts.list_room_ids()` вызвать `manager.kick(room_id, user_id, reason=...)` (blocked →
«Учётная запись заблокирована», role change → «Ваша роль изменилась»); password reset —
`set_password` + `delete_user_sessions` + kick с «Пароль изменён — войдите снова».
Список: сортировка `pending` первыми, затем `created_at DESC`; `q` — contains по name/login.

- [ ] **Step 4: Прогнать тесты и весь бэкенд**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_admin_api.py -q -p no:warnings`
Expected: PASS. Полный `pytest` — PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "feat: add admin user management"
```

---

### Task 6: WS по cookie, доступ к комнате и staff-права

**Files:**
- Modify: `backend/app/api/ws.py`
- Modify: `backend/app/services/room_manager.py` (staff-проверки через `is_staff`)
- Modify: `backend/app/models/schemas.py` (если нужно для `UserInfo`)
- Test: `backend/tests/test_accounts_ws.py`

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `AccountStore.get_session_user`, `get_room`,
  `has_room_access`, `can_access_room`, `is_staff`.
- Produces: WS `/ws/{room_id}` с cookie; старый `?token=` продолжает работать до Task 7
  (помечено `# legacy до Task 7`). Коды: 4401/4403/4404 по Global Constraints.
  `ConnectedUser.role` — из БД; в комнате `teacher|admin` считаются staff.

- [ ] **Step 1: Написать падающие WS-тесты**

В `test_accounts_ws.py` (все соединения через cookie-заголовок):

```python
def test_ws_without_cookie_closes_4401(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/r_missing"):
            pass
    assert exc.value.code == 4401

def test_pending_user_cannot_connect(client, ...):
    ...  # register (login запрещён), session создать через store -> 4401

def test_room_must_exist(client):
    ...  # active user, cookie, /ws/r_nope -> 4404

def test_student_without_grant_gets_4403_then_works_after_grant(client):
    ...  # 4403; PUT access; connect; receives init with objects

def test_revoke_access_kicks_live_socket(client):
    ...  # connect; PUT access []; receives kicked "Учитель отменил доступ к комнате"; close 4403

def test_block_and_role_change_kick_live_socket(client):
    ...  # admin PATCH blocked -> kicked "Учётная запись заблокирована"; 4403
         # PATCH role teacher -> kicked "Ваша роль изменилась"; 4403

def test_admin_joins_foreign_room_with_teacher_powers(client):
    ...  # admin connector: clear/delete works

def test_demoted_teacher_loses_room_after_reconnect(client):
    ...  # owner teacher connects; PATCH role student; kicked; new connect -> 4403
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_accounts_ws.py -q -p no:warnings`
Expected: FAIL (cookie-аутентификации нет).

- [ ] **Step 3: Реализовать**

В `websocket_endpoint`: cookie-сессия → пользователь, статус `active` (иначе 4401); комната из
`accounts.get_room` (иначе 4404); доступ по правилу (иначе 4403); только затем
`manager.join`. Роль — из БД. Заменить проверки `role != "teacher"` на `not is_staff(role)`
во всех хендлерах (`_handle_*` для clear/delete/kick/pages/pull) и в `_can_edit_object`.
Legacy-ветка `?token=` — прежнее поведение, `# legacy до Task 7`.

- [ ] **Step 4: Прогнать новые тесты, затем старые**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_accounts_ws.py -q -p no:warnings`
Expected: PASS.
Run: полный `pytest` — PASS (legacy-тесты на `?token=` живы).

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "feat: authenticate websockets by session cookie"
```

---

### Task 7: Удаление legacy-аутентификации и миграция тестов

**Files:**
- Modify: `backend/app/config.py` (удалить `jwt_secret`, `jwt_ttl_hours`, `teacher_code`)
- Modify: `backend/app/services/auth.py` (удалить JWT/TokenPayload, `pick_color` оставить)
- Modify: `backend/app/api/accounts.py` (удалить legacy-ветку логина)
- Modify: `backend/app/api/ws.py` (удалить `?token=`)
- Modify: `backend/app/api/deps.py` (удалить bearer `get_current_user`)
- Modify: `backend/app/api/upload.py` (зависимость `get_auth_user`, `require_same_origin`)
- Modify: `backend/app/main.py` (импорты)
- Modify: `backend/requirements.txt` (удалить `PyJWT`)
- Modify: `backend/tests/conftest.py`, `test_api.py`, `test_ws.py`, `test_workspaces_ws.py`,
  `test_edge_cases.py`, `test_s3.py`
- Modify: `backend/tests/support.py` (дополнить `ensure_room`, `login_user`)

**Interfaces:**
- Produces (тестовая поддержка для всех следующих задач):

```python
# tests/support.py
def ws_connect(client: TestClient, session: str, room: str = "room-1") -> WebSocketTestSession
def cookie(session: str) -> dict[str, str]      # {"wb_session": session}
def ensure_room(accounts: AccountStore, room_id: str, owner: User) -> Room
# conftest.py fixtures
settings                       # admin root/root-pass-1, password_rounds=4
admin_session                  # session id администратора
activate_user(login, role=None)
login_session(login, password) -> str
login_user(name, role, room)   # совместимость: {"token": session, "user": {...}}
```

- [ ] **Step 1: Расширить conftest и support**

`settings`: убрать JWT/код. `login_user` (синхронный) регистрирует пользователя через
`/api/register`, подтверждает через админский PATCH (Task 5), при `role="teacher"` меняет
роль, гарантирует комнату `room` через `asyncio.run(ensure_room(accounts, room, owner))` и
выдаёт доступ студенту; если комната уже существует и пользователь не её владелец, ему
выдаётся `room_access` (это нужно и учителю, который вошёл вторым). Возвращает
`{"token": <session id>, "user": {...}, "roomId": room}`. Владелец новой комнаты — сам
пользователь, если он учитель, иначе `fixture_teacher` (создаётся один раз).

- [ ] **Step 2: Механически заменить WS-подключения**

Во всех тестах шаблон
`with client.websocket_connect(ws_url(token, room)) as (ws, init):` →
`with ws_connect(client, token, room) as (ws, init):` (аргументы как в тесте). Хелпер
`ws_url` удалить.

- [ ] **Step 3: Заменить REST-авторизацию**

`Authorization: Bearer <token>` → `cookies=cookie(token)`; `/api/upload` теперь принимает
cookie. Переписать `test_api.py` (вход/роли → регистрация/подтверждение) и `test_s3.py`.

- [ ] **Step 4: Удалить legacy-код и обновить тесты входа**

Удалить JWT-функции, `teacher_code`, legacy-ветку `POST /api/login`, `?token=` в WS,
bearer-зависимость; `upload` перевести на `get_auth_user`. Тест входа без регистрации/пароля
удалить; добавить проверку, что `/api/login` с именем/ролью/кодом больше не работает (422).

- [ ] **Step 5: Полный прогон**

Run: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
Expected: PASS (все прежние сценарии + новые auth/WS).

- [ ] **Step 6: Линтеры и commit**

```bash
cd backend
..\.venv\Scripts\python.exe -m ruff check .
..\.venv\Scripts\python.exe -m black --check .
git add backend
git commit -m "refactor: remove legacy login and token websockets"
```

---

### Task 8: Фронт — API-клиент, вход/регистрация, boot и E2E входа

**Files:**
- Create: `frontend/js/api.js`
- Create: `frontend/js/auth.js`
- Create: `frontend/js/dashboard.js`
- Modify: `frontend/index.html`
- Modify: `frontend/css/style.css`
- Modify: `frontend/js/main.js`
- Test: `e2e/tests/auth.spec.js`
- Modify: `e2e/playwright.config.js` (env)
- Modify: `e2e/helpers.js` (API-хелперы входа/регистрации/подтверждения)

**Interfaces:**
- Consumes: REST Task 3/5.
- Produces (для задач 9–12):

```js
// api.js
export class ApiError extends Error { status; code; }
async function request(path, { method = 'GET', body } = {})
export const authApi = { register, login, logout, me }
export const roomsApi = { list, all, get, create, rename, remove, access, setAccess }
export const usersApi = { students }
export const adminApi = { listUsers, updateUser, resetPassword }

// auth.js
export function initAuth({ onAuthenticated })   // вешает обработчики формы/табов
export function showAuth(message = '')
export function showStatusScreen(text)

// dashboard.js
export function initDashboard({ onOpenRoom, onLogout })
export function showDashboard({ user, permissions })
```

- [ ] **Step 1: Подготовить E2E-окружение**

`playwright.config.js`: убрать `JWT_SECRET`/`TEACHER_CODE`, добавить
`ADMIN_LOGIN: 'e2e-admin'`, `ADMIN_PASSWORD: 'e2e-admin-pass'`, `PASSWORD_ROUNDS: '4'`.
`helpers.js`: константы `ADMIN_LOGIN/ADMIN_PASSWORD`; `apiLogin(request, login, password)`;
`registerUser(request, {login, name, password})`; `approveUser(request, login)`;
`makeActiveStudent(request, {login, name})`; `makeTeacher(...)`; `uniqueLogin(prefix)`;
`signInWith(request, page, login, password)` (API-вход + `addCookies` в контекст страницы).

- [ ] **Step 2: Написать падающий E2E входа**

`auth.spec.js`: регистрация через UI → экран «Заявка отправлена»; повторный вход → «Заявка на
рассмотрении»; подтверждение через API; вход → `#dashboard` виден, `#dash-name` содержит имя,
`#dash-role` — «Ученик»; выход → экран входа; неверный пароль → текст ошибки.

- [ ] **Step 3: Разметка и стили**

`index.html`: секции `#auth` (табы `#auth-tab-login`/`#auth-tab-register`, форма `#auth-form`
с полями `login`/`password`/`name`, `#auth-error`, `#auth-hint`, `#auth-submit`),
`#status-screen` (`#status-text`, `#status-back`), `#dashboard` (шапка `#dash-name`,
`#dash-role`, `#logout-btn`; секции `#dash-rooms-section` с `#dash-rooms`, `#dash-empty`,
`#create-room`; `#dash-admin` пустая до Task 10). Старую форму `#login` удалить.
`style.css`: карточка входа/табов, экран статуса, шапка и сетка дашборда, карточки комнат.

- [ ] **Step 4: Реализовать `api.js`, `auth.js`, `dashboard.js`, boot в `main.js`**

`api.js`: `fetch(path, {headers: {'Content-Type': 'application/json'}, credentials: 'same-origin'})`;
не-2xx → `ApiError(status, detail.code, detail.message)`; 204 → `null`.
`main.js::boot()`: `authApi.me()` → `startApp`; 401 → `showAuth()`;
`startApp({user, permissions, board})` запоминает их, затем `?room=` в этой задаче ещё
игнорируется (уходим в дашборд); открытие deep-link'а включает Task 11.
`auth.js` обрабатывает login (успех → `onAuthenticated(me)`), register
(успех → `showStatusScreen('Заявка отправлена...')`), ошибки `pending/rejected/blocked/
invalid_credentials` в `#auth-error`. `dashboard.js::showDashboard` заполняет имя/бейдж роли и
показывает «Выйти»; списки комнат появятся в Task 9.

- [ ] **Step 5: Прогнать E2E входа**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/auth.spec.js --reporter=line`
Expected: PASS. (Старые E2E-спеки временно красные: форма входа изменилась; их миграция —
Task 11–12.)

- [ ] **Step 6: Commit**

```bash
git add frontend e2e/tests/auth.spec.js e2e/helpers.js e2e/playwright.config.js
git commit -m "feat: add auth screens and api client"
```

---

### Task 9: Дашборды ученика и учителя, комнаты и доступ

**Files:**
- Modify: `frontend/js/dashboard.js`
- Modify: `frontend/js/main.js` (создание/переименование/удаление комнат, открытие)
- Modify: `frontend/index.html` (карточки комнат, диалог доступа)
- Modify: `frontend/css/style.css`
- Test: `e2e/tests/rooms.spec.js`

**Interfaces:**
- Consumes: `roomsApi`, `usersApi`, `showDashboard`; кнопка «Открыть» ведёт на
  `/?room=<id>` (сам экран комнаты включается в Task 11).
- Produces: DOM-контракт для E2E:
  `.room-card` с `.room-card__name`, кнопками `.room-card__open`, `.room-card__rename`
  (только владелец/админ), `.room-card__access` (только владелец/админ),
  `.room-card__delete`; `#create-room`; диалог `#access-dialog` с `#access-search`,
  `#access-list` (чекбоксы `input[data-user-id]`), `#access-save`, `#access-cancel`.

- [ ] **Step 1: Написать падающий E2E**

`rooms.spec.js`: учитель создаёт комнату (prompt → имя) → карточка в списке; переименование;
ученик не видит комнату; учитель открывает «Доступ», ищет ученика, ставит чекбокс, сохраняет
→ ученик после обновления видит карточку; учитель удаляет комнату → у ученика пропадает;
ученик не видит `#create-room` и кнопок управления.

- [ ] **Step 2: Разметка и рендер**

`dashboard.js`: `renderRooms(rooms, {canManage})` строит `.room-card`; пустое состояние
`#dash-empty` («Пока нет комнат» / «Вам ещё не выдали доступ»); `#create-room` виден
`permissions.canCreateRooms`. Кнопки владельца: переименовать (prompt), доступ, удалить
(confirm «Удалить комнату «…»? Все объекты и доступы будут удалены.»). Обновление по
`window.focus` и после действий.

- [ ] **Step 3: Диалог доступа**

`index.html`: `<dialog id="access-dialog">` с заголовком `#access-title`, поиском
`#access-search`, списком `#access-list`, кнопками. `dashboard.js`: открыть → параллельно
`roomsApi.access(id)` и `usersApi.students('')`; при вводе — поиск с debounce 250 мс;
сохранить → `roomsApi.setAccess(id, checkedIds)`, закрыть, перерисовать.

- [ ] **Step 4: Прогнать E2E комнат**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/rooms.spec.js --reporter=line`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend e2e/tests/rooms.spec.js
git commit -m "feat: add room dashboards and access management"
```

---

### Task 10: Админская панель

**Files:**
- Modify: `frontend/js/dashboard.js`
- Modify: `frontend/js/main.js`
- Modify: `frontend/index.html`
- Modify: `frontend/css/style.css`
- Test: `e2e/tests/admin.spec.js`

**Interfaces:**
- Consumes: `adminApi`, `roomsApi.all`, `showDashboard`.
- Produces: `#dash-admin` (виден при `permissions.canManageAccounts`) с табами
  `#admin-tab-users` / `#admin-tab-rooms`; `#admin-users` (строки `.admin-user` с
  `.admin-user__login`, `.admin-user__status`, кнопками `.admin-user__approve`,
  `.admin-user__reject`, `.admin-user__block`, `.admin-user__password`, селектом
  `.admin-user__role`); `#admin-rooms` (строки `.admin-room` с `.admin-room__open`,
  `.admin-room__delete`); фильтр `#admin-status-filter`.

- [ ] **Step 1: Написать падающий E2E**

`admin.spec.js`: админ видит заявку и подтверждает её (студент входит); повышает студента до
учителя (появляется `#create-room` после повторного входа); блокирует — вход даёт «заблокирована»;
сбрасывает пароль — старый пароль не работает, новый работает; вкладка «Комнаты» показывает
чужую комнату, админ открывает её.

- [ ] **Step 2: Реализовать панель**

`dashboard.js`: табы, загрузка `adminApi.listUsers({status, q})`, строки с действиями
(`PATCH`, `POST password` с prompt), защита админа (кнопки скрыты для `role==='admin'`);
«Комнаты» — `roomsApi.all()`, открыть/удалить. После блокировки/смены роли — перерисовать.

- [ ] **Step 3: Прогнать E2E админки**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/admin.spec.js --reporter=line`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend e2e/tests/admin.spec.js
git commit -m "feat: add admin users panel"
```

---

### Task 11: Экран комнаты, cookie-WS, выход и deep-link

**Files:**
- Modify: `frontend/js/main.js` (openRoom/leaveRoom/logout, шапка комнаты)
- Modify: `frontend/js/sync.js` (cookie, коды закрытия)
- Modify: `frontend/js/dashboard.js` (открытие комнаты)
- Modify: `frontend/index.html` (`#room-title`, `#leave-btn`)
- Modify: `e2e/helpers.js` (полная замена `login`/`uniqueRoom` на новые хелперы)
- Test: `e2e/tests/lesson.spec.js` (переписать), `e2e/tests/reconnect.spec.js` (переписать)
- Test: `e2e/tests/expired-session.spec.js` (новый)

**Interfaces:**
- Consumes: `roomsApi.get`, `authApi.logout`, `initDashboard`.
- Produces: `openRoom(roomId)`, `leaveRoom()`, `logout()`; `SyncClient({ roomId, workspaceId,
  onEvent, onStatus, onFatal })` без токена; `sessionStorage['wb:room'] = JSON.stringify(
  { roomId, workspaceId })`.

- [ ] **Step 1: Написать падающие E2E**

`lesson.spec.js` (переписать на новых хелперах): учитель и ученик созданы через API, учитель
создал комнату и выдал доступ; оба открывают её из дашборда; рисование/курсор/reload — как в
старом сценарии; «Выйти из комнаты» возвращает на дашборд, доска перестаёт отвечать.
`reconnect.spec.js`: обрыв сокета без reload сохраняет комнату и страницу.
`expired-session.spec.js`: открыть комнату, удалить cookie (`context.clearCookies()`) и
оборвать WS (`routeWebSocket`) → клиент уходит на `#auth`, а не циклит реконнект.

- [ ] **Step 2: Реализовать экран комнаты**

`main.js`: `openRoom` → `roomsApi.get` (403/404 → дашборд + toast) → `startRoom({room, board,
user, permissions})`; шапка `#room-title` = имя комнаты, `#leave-btn` = «Выйти из комнаты»;
`startRoom` создаёт Board/Tools/SyncClient без токена и подключается.
`leaveRoom`: `sync.close()`, destroy board/tools, `history.replaceState('/')`, дашборд.
`kicked`: toast причины + `leaveRoom()`. `FATAL_MESSAGES`: 4401 → `showAuth`, 4403 → дашборд,
4404 → дашборд; после фатального закрытия reconnect не запускается.
`SyncClient`: URL без `?token=`; маппинг кодов 4400/4401/4403/4404/4409.
`sessionStorage['wb:room']` вместо старой сессии; при загрузке `?room=` взять сохранённый
`workspaceId`, если roomId совпадает. В `renderUsers()` добавить бейдж «администратор» для
роли `admin` (бейдж «учитель» остаётся для `teacher`).

- [ ] **Step 3: Прогнать E2E**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/lesson.spec.js tests/reconnect.spec.js tests/expired-session.spec.js --reporter=line`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend e2e
git commit -m "feat: open rooms with cookie sessions"
```

---

### Task 12: Миграция E2E прав, страниц и мобильного; отзыв доступа

**Files:**
- Test: `e2e/tests/permissions.spec.js`, `e2e/tests/workspaces.spec.js`,
  `e2e/tests/mobile.spec.js`, `e2e/tests/revoke.spec.js`
- Modify: `e2e/helpers.js` (если нужны хелперы доступа)

**Interfaces:**
- Consumes: хелперы Task 8/11.
- Produces: полный зелёный E2E-набор.

- [ ] **Step 1: Переписать сценарии на новых хелперах**

- `permissions.spec.js`: ученик не может очищать/удалять/отключать/управлять страницами;
  учитель может clear/kick; админ может clear/kick в чужой комнате.
- `workspaces.spec.js`: все 6 прежних сценариев (создание/изоляция/переключение/переименование/
  порядок/reload/reconnect; удаление цели переключения; удаление непустой страницы; перенос
  одного/всех с сохранением черновика) на новой авторизации.
- `mobile.spec.js`: вход, дашборд, открытие комнаты, полоса страниц, рисование.
- `revoke.spec.js` (новый): ученик внутри комнаты → учитель убирает доступ в диалоге →
  ученик получает сообщение, возвращается на дашборд, комната исчезла; повторный вход по
  deep-link `/?room=<id>` даёт «Нет доступа». Второй сценарий: администратор понижает
  учителя-владельца, пока тот внутри комнаты → учителя выкидывает, после повторного входа
  комната в его дашборде не появляется (он больше не владелец-учитель).

- [ ] **Step 2: Прогнать полный E2E**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test --reporter=line`
Expected: PASS (все спеки, desktop + mobile).

- [ ] **Step 3: Commit**

```bash
git add e2e
git commit -m "test: migrate e2e suite to accounts"
```

---

### Task 13: Документация, окружение и финальный регресс

**Files:**
- Modify: `README.md`, `plan.md`, `docs/deploy.md`, `.env.example`,
  `docker-compose.yml`, `docker-compose.prod.yml`, `.github/workflows/ci.yml`
- Delete: `scripts/load_test.py`
- Modify: `e2e/playwright.config.js` (если остались упоминания кода учителя)

**Interfaces:**
- Consumes: всё готовое.

- [ ] **Step 1: Обновить конфиги окружения**

`.env.example`: удалить `JWT_*`, `TEACHER_CODE`; добавить `ADMIN_LOGIN`, `ADMIN_PASSWORD`,
`ADMIN_NAME`, `SESSION_TTL_HOURS=12`, `COOKIE_SECURE=false`, `PASSWORD_ROUNDS=12`.
`docker-compose.yml`/`docker-compose.prod.yml`: те же переменные вместо старых; в проде
`COOKIE_SECURE=true`. CI: E2E-окружение задаёт `ADMIN_LOGIN`/`ADMIN_PASSWORD` (через
`playwright.config.js`); отдельных шагов не добавлять.

- [ ] **Step 2: Обновить документацию**

README: роли, регистрация/подтверждение, комнаты и выдача доступа, cookie-сессии, новые
REST-эндпоинты, настройки, структура (`services/accounts.py`, `services/access.py`,
`api/accounts.py`, `api/rooms.py`, `api/admin.py`, `js/api.js`, `js/auth.js`,
`js/dashboard.js`), тесты и сценарии E2E; убрать код учителя, JWT и нагрузочный тест.
`docs/deploy.md`: `ADMIN_*`, `COOKIE_SECURE`, TLS для cookie, отсутствие JWT.
`plan.md`: новая секция итерации с чекбоксами и журналом.

- [ ] **Step 3: Удалить нагрузочный тест**

Удалить `scripts/load_test.py`; убрать упоминания из README/plan/CI/документации.

- [ ] **Step 4: Финальный регресс**

```bash
cd backend
..\.venv\Scripts\python.exe -m pytest -q -p no:warnings
..\.venv\Scripts\python.exe -m ruff check .
..\.venv\Scripts\python.exe -m black --check .
cd ..\e2e
$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test
cd ..
docker compose config --quiet
```

Expected: pytest — все зелёные; ruff/black — чисто; Playwright — все сценарии; compose — exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: describe accounts and owned rooms"
```
