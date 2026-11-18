# Главная страница «Кабинет» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить текущий дашборд на согласованный ролевой экран «Кабинет» из макета `mockups/main-page-redesign/`, сохранив API, права и экран комнаты.

**Architecture:** Новый каркас (сайдбар + рабочая область) живёт в `frontend/index.html`, стили — в отдельном `frontend/css/dashboard.css`, всё скоупится под `#dashboard`. `frontend/js/dashboard.js` переписывается на рендер по роли и состоянию, с модальными диалогами вместо `prompt`/`confirm`. Серверная часть не меняется: ученик/учитель используют `roomsApi.list()`, админ — `roomsApi.all()`, пользователи — `adminApi`.

**Tech Stack:** HTML5, CSS, vanilla JS ES-модули, FastAPI REST API, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-main-page-redesign-design.md`

## Global Constraints

- Бэкенд и схемы API не менять.
- Экран комнаты (`#app`), вход (`#auth`), панели доски и стили `.toolbar`, `.workspace`, `.pages-panel`, `.users-panel` не трогать.
- Новые стили — только в `frontend/css/dashboard.css`, каждый селектор начинается с `#dashboard`.
- Все тексты интерфейса — на русском; статус `pending` в админке подписан «Заявка».
- Сохранить якоря E2E: `#dashboard`, `#dash-name`, `#dash-role`, `#create-room`, `#dash-empty`, `.room-card`, `.room-card__name`, `.room-card__access`, `#access-dialog`, `#access-search`, `#access-list`, `.access-item`, `#access-save`, `#admin-search`, `#admin-refresh`, `#admin-tab-rooms`, `#admin-tab-users`.
- Никаких новых зависимостей и сборки; иконки — inline SVG.
- Клиентская фильтрация комнат и пользователей; запросы к API — только существующие методы `api.js`.

## Review Focus

- **Права ролей.** Ученик не должен видеть создание, доступ, переименование и удаление; учитель — только свои комнаты; админ — все комнаты и управление пользователями.
- **Админ без комнат.** Админская главная обязана показывать `GET /api/rooms/all`, а не пустой список собственных комнат.
- **Выдача доступа.** Поиск, отмеченные ученики и сохранение не должны терять выбор; после сохранения диалог закрывается, ошибка остаётся в диалоге.
- **Сессия.** Любой 401 в загрузке/действии вызывает `onSessionLost`, а не молчаливый пустой экран.
- **Мобильная ширина.** На 390 px и 1120 px нет горизонтального скролла, кнопки действий не обрезаются, диалоги помещаются.
- **Общий toast.** Дашборд использует существующий `#toast`; переход из комнаты с сообщением «Нет доступа» не должен его перезаписывать.

---

### Task 1: Каркас кабинета и стили

**Files:**
- Modify: `frontend/index.html` — заменить блок `#dashboard`, добавить `<link rel="stylesheet" href="/css/dashboard.css" />`.
- Create: `frontend/css/dashboard.css`.

**Interfaces:**
- Produces: DOM-якоря `#db-nav`, `#db-tip`, `#dash-name`, `#dash-role`, `#db-eyebrow`, `#db-title`, `#db-subtitle`, `#db-page-actions`, `#db-page-body`, `#logout-btn`; диалоги `#create-room-dialog`, `#rename-room-dialog`, `#delete-room-dialog`, `#access-dialog`, `#password-dialog`.

- [ ] **Step 1: Разметить каркас.**

  В `#dashboard` положить `.db-shell` с `.db-sidebar` и `.db-main`. В сайдбаре: бренд, `<nav id="db-nav">`, `<div id="db-tip">`, карточка пользователя с `#dash-avatar`, `#dash-name`, `#dash-role`, `#logout-btn`. В основной части: заголовок `#db-eyebrow` / `#db-title` / `#db-subtitle`, `#db-page-actions`, `#db-page-body`.

- [ ] **Step 2: Добавить стили каркаса.**

  В `dashboard.css` задать `#dashboard { height: 100vh; overflow-y: auto; background: #f4f7fb; }`, `.db-shell { display:flex; min-height:100vh; }`, `.db-sidebar` шириной 264 px со `position: sticky`, `.db-main` с ограничением ширины и адаптивом: до 1180 px — сетка карточек 2 колонки, до 900 px — сайдбар сверху, до 640 px — 1 колонка и кнопки 44 px.

- [ ] **Step 3: Проверить, что вход и комната не сломались.**

  Run: `cd e2e && npx playwright test tests/auth.spec.js tests/lesson.spec.js`
  Expected: PASS (дашборд виден после входа, комната открывается).

- [ ] **Step 4: Commit.**

  ```bash
  git add frontend/index.html frontend/css/dashboard.css
  git commit -m "feat: add role-based dashboard shell"
  ```

---

### Task 2: Рендер комнат по роли

**Files:**
- Modify: `frontend/js/dashboard.js` — заменить кэш элементов и `renderRooms`.
- Modify: `e2e/tests/rooms.spec.js` — создание через модалку.

**Interfaces:**
- Consumes: `roomsApi.list()`, `roomsApi.all()`, `roomsApi.create(name)`.
- Produces: `showDashboard({user, permissions})`, `initDashboard({onOpenRoom,onLogout,onSessionLost})`; DOM `#create-room`, `#dash-empty`, `.room-card`, `.room-card__name`, `.room-card__open`, `.room-card__access`, `.room-card__menu`.

- [ ] **Step 1: Обновить тест создания комнаты.**

  В `rooms.spec.js` заменить `page.once('dialog')` + `#create-room` на:
  `click('#create-room')`, `fill('#create-room-name', 'Алгебра')`, `click('#create-room-submit')`.
  Ожидание: `.room-card__name` с текстом «Алгебра».

- [ ] **Step 2: Запустить тест и увидеть падение.**

  Run: `cd e2e && npx playwright test tests/rooms.spec.js -g "teacher manages rooms"`
  Expected: FAIL — нет `#create-room-name`.

- [ ] **Step 3: Реализовать рендер.**

  `showDashboard` запоминает `user`, `permissions`, ставит роль, показывает `#dashboard`, скрывает `#auth`, `#status-screen`, `#app`, сбрасывает страницу на `rooms`, рендерит сайдбар и заголовок. `loadRooms`: для `admin` — `roomsApi.all()`, иначе `roomsApi.list()`. Карточка показывает название, владельца («Вы — владелец» для учителя-владельца, иначе «Учитель: Имя»), кнопку «Открыть» / «Войти в комнату», «Доступ» и меню только при праве управления. Поиск фильтрует по названию и имени владельца.

- [ ] **Step 4: Добавить пустые состояния.**

  `#dash-empty`: ученик — «Пока нет занятий» + «Обновить»; учитель — «Создайте первую комнату» + кнопка; админ — «Комнат пока нет». При пустом поиске — «Ничего не найдено» + «Сбросить поиск».

- [ ] **Step 5: Запустить тест.**

  Run: `cd e2e && npx playwright test tests/rooms.spec.js -g "teacher manages rooms"`
  Expected: PASS на шаге создания.

- [ ] **Step 6: Commit.**

  ```bash
  git add frontend/js/dashboard.js e2e/tests/rooms.spec.js
  git commit -m "feat: render role-based room cards"
  ```

---

### Task 3: Диалоги переименования и удаления

**Files:**
- Modify: `frontend/js/dashboard.js`.
- Modify: `e2e/tests/rooms.spec.js`.

**Interfaces:**
- Produces: `openRename(room)`, `openDelete(room)`; DOM `#rename-room-name`, `#rename-room-submit`, `#delete-room-confirm`, `.room-card__rename`, `.room-card__delete`.

- [ ] **Step 1: Обновить тест.**

  Открыть меню карточки `.room-card__menu`, нажать `.room-card__rename`, заполнить `#rename-room-name`, нажать `#rename-room-submit`, ожидать новое `.room-card__name`. Затем меню → `.room-card__delete` → `#delete-room-confirm`, ожидать 0 карточек.

- [ ] **Step 2: Запустить и увидеть падение.**

  Run: `cd e2e && npx playwright test tests/rooms.spec.js -g "teacher manages rooms"`
  Expected: FAIL — нет `#rename-room-name`.

- [ ] **Step 3: Реализовать диалоги.**

  `<dialog>` с формой; валидация непустого имени (1–80 символов); `roomsApi.rename` / `roomsApi.remove`; после успеха — перезагрузка списка и toast; ошибка — в `#rename-room-error` / `#delete-room-error`. Кнопки меню имеют `aria-haspopup` и `aria-expanded`, закрываются по клику вне и по `Esc`.

- [ ] **Step 4: Запустить тест.**

  Run: `cd e2e && npx playwright test tests/rooms.spec.js -g "teacher manages rooms"`
  Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add frontend/js/dashboard.js e2e/tests/rooms.spec.js
  git commit -m "feat: add rename and delete room dialogs"
  ```

---

### Task 4: Диалог доступа

**Files:**
- Modify: `frontend/js/dashboard.js`.
- Modify: `frontend/index.html` — разметка `#access-dialog`.
- Test: `e2e/tests/revoke.spec.js` (без изменений селекторов).

**Interfaces:**
- Consumes: `roomsApi.access(id)`, `usersApi.students(q)`, `roomsApi.setAccess(id, userIds)`.
- Produces: `openAccess(room)`; DOM `#access-title`, `#access-search`, `#access-list`, `.access-item`, `#access-count`, `#access-clear`, `#access-save`, `#access-error`.

- [ ] **Step 1: Проверить существующий тест.**

  Run: `cd e2e && npx playwright test tests/revoke.spec.js`
  Expected: PASS после реализации; сейчас падает на `#access-dialog` (если ещё не реализован).

- [ ] **Step 2: Реализовать диалог.**

  При открытии — `Promise.all([roomsApi.access(room.id), usersApi.students('')])`; выбранные — из ответа access; список фильтруется по имени/логину на клиенте; счётчик «Выбрано: N учеников»; «Снять всех»; сохранение — `setAccess(room.id, [...selected])`; успех — закрыть и toast; ошибка — `#access-error`.

- [ ] **Step 3: Запустить тесты доступа.**

  Run: `cd e2e && npx playwright test tests/revoke.spec.js tests/rooms.spec.js -g "access"`
  Expected: PASS.

- [ ] **Step 4: Commit.**

  ```bash
  git add frontend/index.html frontend/js/dashboard.js
  git commit -m "feat: add access dialog with search"
  ```

---

### Task 5: Админская страница пользователей

**Files:**
- Modify: `frontend/js/dashboard.js`.
- Modify: `e2e/tests/admin.spec.js`.

**Interfaces:**
- Consumes: `adminApi.listUsers({})`, `adminApi.updateUser(id, patch)`, `adminApi.resetPassword(id, password)`.
- Produces: nav `#admin-tab-rooms` / `#admin-tab-users`; page `#dash-admin`, `#admin-search`, `#admin-refresh`; rows `.db-user-row`, `.db-user-row__status`, `[data-user-action]`, `[data-user-role]`; dialog `#password-dialog`, `#password-value`, `#password-submit`.

- [ ] **Step 1: Обновить `adminPage` в тесте.**

  После входа ждать `#dashboard`, нажать `#admin-tab-users`, ждать `#dash-admin`. Статус заявки — «Заявка». Пароль — открыть `[data-user-action="password"]`, заполнить `#password-value`, нажать `#password-submit`.

- [ ] **Step 2: Запустить и увидеть падение.**

  Run: `cd e2e && npx playwright test tests/admin.spec.js`
  Expected: FAIL — нет `#admin-tab-users`.

- [ ] **Step 3: Реализовать страницу.**

  Админская навигация: «Все комнаты» + «Пользователи» с бейджем заявок. Загрузка пользователей при входе (для бейджа) и при открытии страницы. Табы «Все / Заявки / Активные / Заблокированные» считают локальный список; поиск фильтрует по имени и логину; действия — подтвердить, отклонить, заблокировать/разблокировать, сменить роль, пароль. После действия — обновить локальную запись, перерисовать строки и бейдж, показать toast. 401 — `onSessionLost()`.

- [ ] **Step 4: Запустить тест.**

  Run: `cd e2e && npx playwright test tests/admin.spec.js`
  Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add frontend/js/dashboard.js e2e/tests/admin.spec.js
  git commit -m "feat: add admin users page"
  ```

---

### Task 6: Адаптив, доступность и проверка

**Files:**
- Modify: `frontend/css/dashboard.css`.
- Modify: `frontend/js/dashboard.js` — мелочи фокуса и закрытия меню.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Проверить 1120 px.**

  Открыть `#dashboard` админом на 1120×896; в таблице пользователей действия не обрезаются, горизонтального скролла нет.

- [ ] **Step 2: Проверить 390 px.**

  Открыть ученика и учителя на 390×844; нет горизонтального скролла; карточки в одну колонку; диалоги не выходят за экран; кнопки не меньше 44 px.

- [ ] **Step 3: Проверить клавиатуру.**

  `Tab` доходит до навигации, карточек и диалогов; `Esc` закрывает диалоги и меню; видимый `:focus-visible`.

- [ ] **Step 4: Запустить весь E2E-набор.**

  Run: `cd e2e && $env:PYTHON='..\.venv\Scripts\python.exe'; npx playwright test`
  Expected: PASS.

- [ ] **Step 5: Запустить бэкенд-тесты (регрессия).**

  Run: `cd backend && ..\.venv\Scripts\python -m pytest`
  Expected: PASS.

- [ ] **Step 6: Commit.**

  ```bash
  git add frontend/css/dashboard.css frontend/js/dashboard.js
  git commit -m "fix: polish dashboard responsive and keyboard behavior"
  ```

---

### Task 7: Макет экрана комнаты (следующий этап, после согласования главной)

Не входит в реализацию текущей задачи. После сдачи главной подготовить
`mockups/room-redesign/index.html` с теми же принципами: понятная иерархия,
ролевые состояния, аккуратные сайдбары «Страницы» и «Участники», компактные
панели инструментов, адаптив и состояния для презентаций. Отдельный дизайн-док
и согласование перед внедрением в `#app`.
