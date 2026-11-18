# Отмена в презентациях и сворачивание сайдбаров: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разрешить учителю отменять последний штрих текущего слайда презентации и добавить сворачивание/разворачивание панелей «Страницы» и «Участники» с запоминанием состояния.

**Architecture:** Записи серверной истории в презентациях получают номер слайда, а `undo` выбирает последнюю запись текущего слайда; UI-кнопка отмены показывается только staff. Панели сворачиваются CSS-классом `is-collapsed` до узкой полоски, состояние хранится в `localStorage`, а Konva пересчитывает размер через `board.layout()`.

**Tech Stack:** FastAPI, pytest, ванильный JS, Konva.js, CSS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-presentation-undo-sidebars-design.md`

## Global Constraints

- Отмена на презентации — только для staff и только по текущему слайду.
- Формат ключей истории, снимки и Redis не меняются.
- Ученик на презентации не может рисовать и отменять (`presentation_view_only`).
- Состояние панелей: `localStorage` ключи `wb:pagesCollapsed`, `wb:usersCollapsed`, значения `'1'`/`'0'`, по умолчанию развёрнуты.
- Новых зависимостей нет; русские подписи и существующий стиль кода.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.

## Review Focus

- Отмена на слайде 2 не удаляет штрих со слайда 1, и наоборот.
- Ученик не видит кнопку отмены и получает ошибку при сыром WS-сообщении `undo`.
- Сворачивание панелей не ломает размер Konva-доски и сохранённый зум.
- После перезагрузки свёрнутые панели остаются свёрнутыми, а кнопки разворота доступны.
- На мобильном полоса страниц не исчезает вместе с кнопкой разворота.

---

## Структура файлов

- `backend/app/services/room_manager.py` — выбор записи истории по слайду.
- `backend/app/api/ws.py` — метка слайда в истории, разрешение и проверка прав `undo`.
- `backend/tests/test_presentations_ws.py` — тесты отмены по слайду и запрета ученику.
- `frontend/js/main.js` — показ кнопки отмены staff, состояние панелей и `localStorage`.
- `frontend/js/pages.js` — кнопка сворачивания в заголовке страниц.
- `frontend/index.html` — заголовок панели участников с кнопкой.
- `frontend/css/style.css` — стили свёрнутых панелей и адаптация под мобильный.
- `e2e/tests/presentations.spec.js` — отмена на слайде, изоляция, кнопка у ученика.
- `e2e/tests/ui-polish.spec.js` — сворачивание обеих панелей и сохранение состояния.
- `e2e/tests/mobile.spec.js` — сворачивание полосы страниц на телефоне.
- `README.md`, `plan.md` — документация и журнал.

---

### Task 1: Отмена на текущем слайде презентации

**Files:**
- Modify: `backend/app/services/room_manager.py:609-613`
- Modify: `backend/app/api/ws.py:100-115`, `:128-175`, `:1111-1157`, `:461`
- Test: `backend/tests/test_presentations_ws.py`
- Modify: `frontend/js/main.js:469-472`, `:572-579`, `:778`
- Test: `e2e/tests/presentations.spec.js`

**Interfaces:**
- Produces: `RoomManager.pop_history(room, user_id, workspace_id, slide_index: int | None = None) -> dict | None`
- Produces: `_push_history(manager: RoomManager, room: Room, user: ConnectedUser, entry: dict[str, Any]) -> None`
- Produces: история в презентациях содержит `entry["slide"]: int`.

- [ ] **Step 1: Написать падающий backend-тест**

Добавить в `backend/tests/test_presentations_ws.py` после `test_presentation_permissions`:

```python
def test_presentation_undo_is_per_slide(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    slides = upload_presentation(client, teacher["token"])

    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        workspace = create_presentation(tw, slides)
        recv_until(sw, "workspace_created")
        sw.send_json({"type": "workspace_switch", "workspaceId": workspace["id"]})
        recv_until(sw, "workspace_state")

        stroke_start(tw, "s0")
        recv_until(sw, "stroke_start")
        finish_stroke(tw, "s0")
        recv_until(sw, "stroke_end")

        tw.send_json({"type": "presentation_slide", "slideIndex": 1})
        recv_until(sw, "presentation_slide")
        recv_until(tw, "presentation_slide")
        stroke_start(tw, "s1")
        recv_until(sw, "stroke_start")
        finish_stroke(tw, "s1")
        recv_until(sw, "stroke_end")

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["s1"]
        assert recv_until(sw, "objects_restored")["removedIds"] == ["s1"]

        tw.send_json({"type": "presentation_slide", "slideIndex": 0})
        back = recv_until(sw, "presentation_slide")
        assert [obj["id"] for obj in back["objects"]] == ["s0"]
        recv_until(tw, "presentation_slide")

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["s0"]
        assert recv_until(sw, "objects_restored")["removedIds"] == ["s0"]

        tw.send_json({"type": "undo"})
        assert "undo_empty" in codes(barrier(tw))

        sw.send_json({"type": "undo"})
        assert "presentation_view_only" in codes(barrier(sw))
```

В `test_presentation_permissions` заменить проверку `undo` у учителя:

```python
        tw.send_json({"type": "undo"})
        assert "presentation_view_only" in codes(barrier(tw))
```

на проверку ученика:

```python
        sw.send_json({"type": "undo"})
        assert "presentation_view_only" in codes(barrier(sw))
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_presentations_ws.py -q -p no:warnings`
Expected: FAIL — `undo` у учителя даёт `presentation_view_only`, `pop_history` не принимает `slide_index`.

- [ ] **Step 3: Реализовать фильтр истории по слайду**

В `RoomManager.pop_history` заменить тело на выбор последней подходящей записи:

```python
    def pop_history(
        self,
        room: Room,
        user_id: str,
        workspace_id: str,
        slide_index: int | None = None,
    ) -> dict[str, Any] | None:
        stack = room.history.get((user_id, workspace_id))
        if not stack:
            return None
        if slide_index is None:
            return stack.pop()
        for index in range(len(stack) - 1, -1, -1):
            if stack[index].get("slide") == slide_index:
                return stack.pop(index)
        return None
```

- [ ] **Step 4: Помечать записи истории номером слайда**

В `backend/app/api/ws.py` добавить `"undo"` в `PRESENTATION_ALLOWED` и helper рядом с `_push_create`:

```python
def _push_history(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    entry: dict[str, Any],
) -> None:
    workspace = room.get_workspace(user.workspace_id)
    if workspace and workspace.get("kind") == PRESENTATION_KIND:
        entry["slide"] = int(workspace.get("slideIndex", 0) or 0)
    manager.push_history(room, user.id, user.workspace_id, entry)
```

Заменить три прямых вызова `manager.push_history(...)` в `_push_create`, `_push_fields`
и `_push_delete` на `_push_history(manager, room, user, {...})`.

- [ ] **Step 5: Разрешить `undo` staff и отфильтровать по слайду**

В `_handle_undo` после `_check_workspace` добавить:

```python
    workspace = room.get_workspace(user.workspace_id)
    presentation = bool(workspace and workspace.get("kind") == PRESENTATION_KIND)
    if presentation and not is_staff(user.role):
        await manager.send_to(
            user,
            _error("presentation_view_only", "На презентации доступна только кисть учителя"),
        )
        return
    slide_index = (
        int(workspace.get("slideIndex", 0) or 0) if presentation else None
    )
```

и передать фильтр в цикл:

```python
        entry = manager.pop_history(room, user.id, user.workspace_id, slide_index)
```

- [ ] **Step 6: Прогнать backend-тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_presentations_ws.py tests/test_board_undo_lock.py -q -p no:warnings`
Expected: все passed, включая новый тест.

- [ ] **Step 7: Написать падающие E2E-проверки**

В `e2e/tests/presentations.spec.js` после рисования на слайде 2 (строка с
`expect.poll(() => objectCount(teacher)).toBe(1)`) добавить:

```js
  await expect(teacher.locator('#undo-btn')).toBeVisible();
  await teacher.click('#undo-btn');
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await drawBrush(teacher, { x: 420, y: 220 }, { x: 620, y: 220 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
```

После проверки рисования учеником (строка с `expect(await objectCount(student)).toBe(1)`)
добавить:

```js
  await expect(student.locator('#undo-btn')).toBeHidden();
  await teacher.click('#undo-btn');
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await expect.poll(() => objectCount(student)).toBe(0);
```

- [ ] **Step 8: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/presentations.spec.js --timeout=30000`
Expected: FAIL — кнопка отмены скрыта на презентации.

- [ ] **Step 9: Показать кнопку staff и разрешить `requestUndo`**

В `frontend/js/main.js`:

```js
function requestUndo() {
  if (!state.board || state.tools?.isDrawing()) return;
  if (isPresentation() && !isStaff(state.user?.role)) return;
  sendWorkspace({ type: 'undo' });
}
```

В `updateToolbar` и `applyWorkspaceMode` заменить
`els.undoBtn.hidden = presentation;` на:

```js
  els.undoBtn.hidden = presentation && !isStaff(state.user?.role);
```

- [ ] **Step 10: Прогнать E2E**

Run: `npx.cmd playwright test tests/presentations.spec.js --timeout=30000`
Expected: `1 passed`.

- [ ] **Step 11: Коммит**

```bash
git add backend/app/api/ws.py backend/app/services/room_manager.py backend/tests/test_presentations_ws.py frontend/js/main.js e2e/tests/presentations.spec.js
git commit -m "feat: undo presentation strokes per slide"
```

---

### Task 2: Сворачивание сайдбаров

**Files:**
- Modify: `frontend/index.html:296-303`
- Modify: `frontend/js/pages.js:8-55`
- Modify: `frontend/js/main.js:13-16`, `:111-120`, `:176-178`, `:312-321`, `:962-967`
- Modify: `frontend/css/style.css:419-447`, `:569-581`, `:829-865`
- Test: `e2e/tests/ui-polish.spec.js`, `e2e/tests/mobile.spec.js`

**Interfaces:**
- Produces: `PagesPanel` option `onToggleCollapse()` и `render(..., { collapsed = false })`.
- Produces: DOM `#pages-toggle`, `#users-toggle` с `aria-expanded`.
- Produces: main.js `setPagesCollapsed(collapsed, { persist = true } = {})`, `setUsersCollapsed(collapsed, { persist = true } = {})`, `bindSidebarToggles()`.

- [ ] **Step 1: Написать падающий E2E на панели**

Добавить в `e2e/tests/ui-polish.spec.js`:

```js
test('sidebar: pages and participants collapse and remember the state', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Sidebar toggle', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  const pages = page.locator('#pages-panel');
  const users = page.locator('#users-panel');
  const board = page.locator('#board');
  const widthOf = async (locator) => (await locator.boundingBox()).width;

  const initialBoard = await widthOf(board);
  expect(await widthOf(pages)).toBeGreaterThan(150);

  await page.click('#pages-toggle');
  await expect.poll(() => widthOf(pages)).toBeLessThan(60);
  await expect(page.locator('.page-list')).toBeHidden();
  await expect.poll(() => widthOf(board)).toBeGreaterThan(initialBoard + 100);

  const afterPages = await widthOf(board);
  await page.click('#users-toggle');
  await expect.poll(() => widthOf(users)).toBeLessThan(60);
  await expect(page.locator('#users-resizer')).toBeHidden();
  await expect.poll(() => widthOf(board)).toBeGreaterThan(afterPages + 100);

  await openRoom(page, setup.room.id);
  await expect.poll(() => widthOf(pages)).toBeLessThan(60);
  await expect.poll(() => widthOf(users)).toBeLessThan(60);

  await page.click('#pages-toggle');
  await expect.poll(() => widthOf(pages)).toBeGreaterThan(150);
  await page.click('#users-toggle');
  await expect.poll(() => widthOf(users)).toBeGreaterThan(150);
  await expect(page.locator('#users-resizer')).toBeVisible();
});
```

В `e2e/tests/mobile.spec.js` после проверки размеров доски добавить:

```js
  const pagesPanel = page.locator('#pages-panel');
  const fullHeight = (await pagesPanel.boundingBox()).height;
  await page.tap('#pages-toggle');
  await expect.poll(async () => (await pagesPanel.boundingBox()).height).toBeLessThan(fullHeight);
  await expect(page.locator('.page-list')).toBeHidden();
  await page.tap('#pages-toggle');
  await expect(page.locator('.page-list')).toBeVisible();
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/ui-polish.spec.js tests/mobile.spec.js --timeout=30000`
Expected: FAIL — нет `#pages-toggle` и `#users-toggle`.

- [ ] **Step 3: Добавить кнопку и обработчик в панель страниц**

`frontend/js/pages.js`:
- в конструктор добавить `this.onToggleCollapse = onToggleCollapse;`;
- в `render` принять `collapsed = false`;
- первой в `header` вставить кнопку:

```js
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'pages-toggle';
    toggle.className = 'panel-toggle';
    toggle.textContent = collapsed ? '»' : '«';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть страницы' : 'Свернуть страницы');
    toggle.addEventListener('click', () => this.onToggleCollapse?.());
    header.appendChild(toggle);
```

- [ ] **Step 4: Добавить кнопку в панель участников**

`frontend/index.html`: обернуть заголовок участников:

```html
          <div class="users-panel__header">
            <h2 class="users-panel__title">Участники <span id="user-count"></span></h2>
            <button id="users-toggle" class="panel-toggle" type="button"
              aria-label="Свернуть участников" aria-expanded="true">»</button>
          </div>
```

- [ ] **Step 5: Реализовать состояние панелей в main.js**

Добавить константы:

```js
const PAGES_COLLAPSED_KEY = 'wb:pagesCollapsed';
const USERS_COLLAPSED_KEY = 'wb:usersCollapsed';
```

В `cacheElements` добавить `els.usersToggle = $('#users-toggle');`.

Добавить функции:

```js
function setPagesCollapsed(collapsed, { persist = true } = {}) {
  els.pagesPanel.classList.toggle('is-collapsed', collapsed);
  const toggle = $('#pages-toggle');
  if (toggle) {
    toggle.textContent = collapsed ? '»' : '«';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть страницы' : 'Свернуть страницы');
  }
  if (persist) localStorage.setItem(PAGES_COLLAPSED_KEY, collapsed ? '1' : '0');
  state.board?.layout?.();
}

function setUsersCollapsed(collapsed, { persist = true } = {}) {
  els.usersPanel.classList.toggle('is-collapsed', collapsed);
  els.usersResizer.hidden = collapsed;
  els.usersToggle.textContent = collapsed ? '«' : '»';
  els.usersToggle.setAttribute('aria-expanded', String(!collapsed));
  els.usersToggle.setAttribute(
    'aria-label',
    collapsed ? 'Развернуть участников' : 'Свернуть участников',
  );
  if (persist) localStorage.setItem(USERS_COLLAPSED_KEY, collapsed ? '1' : '0');
  state.board?.layout?.();
}

function bindSidebarToggles() {
  els.usersToggle.addEventListener('click', () => {
    setUsersCollapsed(!els.usersPanel.classList.contains('is-collapsed'));
  });
  setPagesCollapsed(localStorage.getItem(PAGES_COLLAPSED_KEY) === '1', { persist: false });
  setUsersCollapsed(localStorage.getItem(USERS_COLLAPSED_KEY) === '1', { persist: false });
}
```

В `init()` после `bindUsersResizer()` вызвать `bindSidebarToggles()`.

В создании `PagesPanel` добавить:

```js
    onToggleCollapse: () => {
      setPagesCollapsed(!els.pagesPanel.classList.contains('is-collapsed'));
      renderPages();
    },
```

В `renderPages()` передать `collapsed`:

```js
    collapsed: els.pagesPanel.classList.contains('is-collapsed'),
```

- [ ] **Step 6: Добавить стили свёрнутых панелей**

В `frontend/css/style.css` рядом с панелями:

```css
.panel-toggle {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: #eef2f7;
  color: #475569;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.panel-toggle:hover {
  background: var(--accent);
  color: #fff;
}

.pages-panel,
.users-panel {
  transition: width 120ms ease;
}

.pages-panel.is-collapsed {
  width: 44px;
  padding: 10px 6px;
  overflow: hidden;
}

.pages-panel.is-collapsed .pages-panel__header,
.users-panel.is-collapsed .users-panel__header {
  flex-direction: column;
  gap: 10px;
}

.pages-panel.is-collapsed .pages-panel__adds,
.pages-panel.is-collapsed .page-list {
  display: none;
}

.pages-panel.is-collapsed .pages-panel__title,
.users-panel.is-collapsed .users-panel__title {
  display: block;
  margin: 4px auto 0;
  font-size: 13px;
  writing-mode: vertical-rl;
}

.users-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.users-panel.is-collapsed {
  width: 44px;
  min-width: 44px;
  padding: 10px 6px;
  overflow: hidden;
}

.users-panel.is-collapsed .user-list,
.users-panel.is-collapsed .users-panel__pull,
.users-panel.is-collapsed .users-panel__hint,
.users-panel.is-collapsed .users-panel__legend {
  display: none;
}
```

В `@media (max-width: 900px)` добавить:

```css
  .pages-panel.is-collapsed {
    width: auto;
    padding: 6px 8px;
    overflow: visible;
  }

  .pages-panel.is-collapsed .pages-panel__header {
    flex-direction: row;
  }

  .pages-panel.is-collapsed .pages-panel__title {
    display: none;
  }
```

- [ ] **Step 7: Прогнать E2E**

Run: `npx.cmd playwright test tests/ui-polish.spec.js tests/mobile.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add frontend/index.html frontend/js/pages.js frontend/js/main.js frontend/css/style.css e2e/tests/ui-polish.spec.js e2e/tests/mobile.spec.js
git commit -m "feat: collapse board sidebars"
```

---

### Task 3: Документация и полная регрессия

**Files:**
- Modify: `README.md`
- Modify: `plan.md`

- [ ] **Step 1: Обновить README**

В «Возможности» добавить:

- к отмене: «Отмена работает и на презентациях: учитель отменяет последний штрих
  текущего слайда кнопкой или `Ctrl+Z`.»
- отдельным пунктом: «Панели «Страницы» и «Участники» сворачиваются в узкую
  полоску кнопкой в заголовке; состояние запоминается в браузере.»

- [ ] **Step 2: Обновить plan.md**

- Раздел `### P11. Отмена на слайдах и сворачивание панелей ✅` с чекбоксами.
- Строка в журнале реализации.
- Пункт 13 в критериях готовности.
- Блок «Проверка отмены и панелей (эта итерация)».
- Актуальные числа тестов по факту прогона.

- [ ] **Step 3: Полная регрессия**

- `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings` → все passed.
- `backend`: `..\.venv\Scripts\python.exe -m ruff check .` и `black --check .` → чисто.
- `e2e`: `npx.cmd playwright test` → все passed.
- `docker compose config --quiet` → 0.

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: presentation undo and sidebar toggles"
```

---

## Self-Review

- **Спека:** отмена staff по слайду (Task 1), запрет ученику (Task 1), панели и
  `localStorage` (Task 2), мобильная полоса (Task 2), документация (Task 3).
- **Review Focus → тесты:** изоляция слайдов (backend + E2E), ученик без кнопки и
  с ошибкой WS (backend + E2E), размер доски и зум (E2E по ширине доски), reload
  (E2E), мобильная кнопка (mobile E2E).
- **Типы:** `pop_history(..., slide_index)` согласован с вызовом в `_handle_undo`;
  `collapsed` в `PagesPanel.render` совпадает с `renderPages`; `#pages-toggle` /
  `#users-toggle` и класс `is-collapsed` одинаковы в JS и CSS.
- **Пропорция:** план задаёт сигнатуры, ключевые формулы и тесты; CSS и тела
  функций приведены полностью только там, где без них остаётся выбор.
