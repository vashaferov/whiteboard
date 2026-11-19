# Панель слайдов и цвет холста — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опустить панель переключения слайдов ниже слайда и добавить учителю постраничный цвет холста с синхронизацией ученикам.

**Architecture:** Панель переносится внутрь `#board`, а сцена презентации резервирует полосу снизу. Цвет хранится в метаданных workspace (`background`) и синхронизируется новым WS-сообщением `workspace_background`; клиент применяет его к CSS-фону доски, листу и экспорту.

**Tech Stack:** FastAPI, Pydantic, WebSocket, Konva.js, vanilla JS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-slide-controls-canvas-color-design.md`

## Global Constraints

- Без новых зависимостей.
- Русские тексты интерфейса и комментарии.
- Цвет — `#rrggbb`, нормализуется в нижний регистр; `null` — сброс.
- Ученик не может менять цвет; невалидный цвет → `invalid_message`.
- Презентация: цвет не влияет на изображение слайда.

## Review Focus

- Слайд на узком/широком окне: панель не должна перекрывать сцену.
- Ученик на другой странице не должен получать чужой цвет.
- Переключение страниц туда-обратно сохраняет цвет каждой страницы.
- Сброс цвета убирает кастомный фон и у учителя, и у ученика.
- Тёмный фон не должен делать точки сетки невидимыми.

---

### Task 1: Панель переключения слайдов ниже слайда

**Files:**
- Modify: `frontend/index.html:489-563`
- Modify: `frontend/css/room.css:1288-1302, 1728-1755`
- Test: `e2e/tests/presentations.spec.js:29-50`

**Interfaces:**
- Produces: `#slide-controls` — потомок `#board`; в презентации `#board-stage` заканчивается выше панели.

- [ ] **Step 1: Добавить проверку в E2E презентации**

В `presentations.spec.js` после проверки `slideName(teacher)` добавить:

```js
const layout = await teacher.evaluate(() => {
  const stage = window.Konva.stages[0];
  const stageBox = stage.container().getBoundingClientRect();
  const controls = document.querySelector('#slide-controls').getBoundingClientRect();
  return { stageBottom: stageBox.bottom, controlsTop: controls.top };
});
expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.stageBottom);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx playwright test tests/presentations.spec.js -g "teacher uploads"`
Expected: FAIL — `controlsTop` меньше `stageBottom`.

- [ ] **Step 3: Перенести панель в `#board` и зарезервировать полосу**

В `index.html` удалить `<div id="slide-controls">` из конца `<main>` и вставить
его внутрь `#board` после `#zoom-controls`.

В `room.css`:
- `.slide-controls { bottom: 12px; }`
- добавить `#app[data-presentation="true"] .board__stage { bottom: 60px; }`
- в `@media (max-width: 900px)`: `.slide-controls { bottom: 8px; }`,
  `#app[data-presentation="true"] .board__stage { bottom: 52px; }`.

- [ ] **Step 4: Прогнать E2E презентации**

Run: `npx playwright test tests/presentations.spec.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend/index.html frontend/css/room.css e2e/tests/presentations.spec.js
git commit -m "fix: keep slide controls below the presentation slide"
```

---

### Task 2: Backend — метаданные цвета холста

**Files:**
- Modify: `backend/app/models/schemas.py:315-320, 476-478`
- Modify: `backend/app/services/workspaces.py:15-26, 107-111`
- Modify: `backend/app/services/room_manager.py:52-75, 738-752`
- Modify: `backend/app/api/ws.py:496-498, 1530-1569`
- Test: `backend/tests/test_workspace_background.py` (новый)

**Interfaces:**
- Produces: сообщение `workspace_background {type, color: str | None}`;
  событие `workspace_background {type, workspaceId, color}`;
  поле `workspace["background"]` и `workspace_state["background"]`.

- [ ] **Step 1: Написать падающие backend-тесты**

Создать `backend/tests/test_workspace_background.py`:

```python
"""Цвет холста страницы."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def test_workspace_background_syncs_and_persists(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        tw.send_json({"type": "workspace_background", "color": "#123ABC"})
        assert recv_until(tw, "workspace_background")["color"] == "#123abc"
        assert recv_until(sw, "workspace_background")["color"] == "#123abc"

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        second = recv_until(tw, "workspace_created")["workspace"]
        recv_until(tw, "workspace_state")
        assert "background" not in second

        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert recv_until(tw, "workspace_state")["background"] == "#123abc"


def test_workspace_background_permissions_and_validation(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        sw.send_json({"type": "workspace_background", "color": "#abcdef"})
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json({"type": "workspace_background", "color": "red"})
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_workspace_background_reset(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)

        tw.send_json({"type": "workspace_background", "color": "#123abc"})
        recv_until(tw, "workspace_background")
        tw.send_json({"type": "workspace_background", "color": None})
        assert recv_until(tw, "workspace_background")["color"] is None

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        recv_until(tw, "workspace_created")
        recv_until(tw, "workspace_state")
        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert "background" not in recv_until(tw, "workspace_state")
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspace_background.py -q -p no:warnings`
Expected: FAIL — сообщение неизвестно / поля нет.

- [ ] **Step 3: Схема, нормализация и состояние**

- `schemas.py`: после `WorkspaceCanvas` добавить `WorkspaceBackground` с
  `color: str | None = Field(default=None, pattern=COLOR_PATTERN)` и включить
  в union клиентских сообщений.
- `workspaces.py`: импортировать `COLOR_PATTERN`; добавить
  `normalize_background(raw) -> str | None` (regex, нижний регистр) и
  сохранять поле у не-презентаций в `normalize_workspaces`.
- `room_manager.py`: добавить `"workspace_background"` в
  `WORKSPACE_SCOPED_EVENTS`; в `_workspace_state_payload` положить
  `payload["background"] = workspace.get("background")`.
- `ws.py`: импортировать схему, вызвать обработчик в диспетчере.

- [ ] **Step 4: Реализовать обработчик**

`_handle_workspace_background` по образцу `_handle_workspace_canvas`:
staff-only (`forbidden`), `_check_workspace`, запрет презентации
(`invalid_message`), `color = message.color.lower() if message.color else None`,
запись/удаление `workspace["background"]`, `mark_dirty`, broadcast события
`workspace_background` с `workspaceId` и `color`.

- [ ] **Step 5: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspace_background.py tests/test_workspace_canvas.py -q -p no:warnings`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/services/workspaces.py \
  backend/app/services/room_manager.py backend/app/api/ws.py \
  backend/tests/test_workspace_background.py
git commit -m "feat: sync per-page canvas background"
```

---

### Task 3: Frontend — выбор и применение цвета

**Files:**
- Modify: `frontend/index.html:350-370`
- Modify: `frontend/css/room.css:573-622, 1173-1193`
- Modify: `frontend/js/board.js:74, 133, 489-545, 585-592`
- Modify: `frontend/js/main.js:181-186, 549-613, 1284-1293, 1480-1484`
- Test: `e2e/tests/board-size.spec.js`

**Interfaces:**
- Consumes: `workspace_background` из Task 2.
- Produces: `Board.setBackground(color: string | null)`,
  `applyWorkspaceCanvas()` применяет и цвет; UI `#board-color`,
  `#board-color-reset`.

- [ ] **Step 1: Написать падающий E2E**

В `board-size.spec.js` добавить импорт `openLesson` и тест:

```js
function background(page) {
  return page.evaluate(() => ({
    color: getComputedStyle(document.querySelector('#board')).backgroundColor,
    custom: document.querySelector('#board').classList.contains('has-custom-bg'),
  }));
}

function setColor(page, value) {
  return page.locator('#board-color').evaluate((el, color) => {
    el.value = color;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('teacher colors the canvas and the student sees the same color', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Canvas color' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await teacher.click('#room-more-btn');
  await teacher.click('#board-size-btn');
  await setColor(teacher, '#123456');
  const expected = { color: 'rgb(18, 52, 86)', custom: true };
  await expect.poll(() => background(teacher)).toEqual(expected);
  await expect.poll(() => background(student)).toEqual(expected);

  await reloadAndWait(teacher);
  await expect.poll(() => background(teacher)).toEqual(expected);

  await teacher.click('#room-more-btn');
  await teacher.click('#board-size-btn');
  await teacher.click('#board-color-reset');
  await expect.poll(() => background(teacher).then((value) => value.custom)).toBe(false);
  await expect.poll(() => background(student).then((value) => value.custom)).toBe(false);

  await teacherContext.close();
  await studentContext.close();
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx playwright test tests/board-size.spec.js -g "colors the canvas"`
Expected: FAIL — `#board-color` отсутствует.

- [ ] **Step 3: Добавить контрол и стили**

В `#board-size-panel` после пресетов:

```html
<label class="board-size-panel__field board-size-panel__color">
  Цвет холста
  <input id="board-color" type="color" value="#ffffff" aria-label="Цвет холста" />
</label>
<button id="board-color-reset" class="btn btn--small" type="button">Сброс</button>
```

CSS: цветной input 34×28; для `.board.has-custom-bg` фон `var(--board-bg)`,
псевдоэлемент с точками скрыт.

- [ ] **Step 4: Реализовать `Board.setBackground`**

В конструкторе: `this.background = null`, `this._gridDotColor = '#d3dcea'`.
В `sceneFunc` сетки использовать `this._gridDotColor`.
`setBackground(color)`:
- валидировать `#rrggbb`, иначе `null`;
- `paper.fill(color || '#ffffff')`;
- класс `has-custom-bg` и переменная `--board-bg` на ближайшем `.board`;
- контрастные точки для тёмного фона;
- перерисовка background layer.
В `exportCanvas` фон экспорта — `this.background || '#ffffff'`.

- [ ] **Step 5: Подключить UI и события в `main.js`**

- `cacheElements`: `els.boardColor`, `els.boardColorReset`.
- `updateBoardSizePanel`: выставлять `els.boardColor.value` из
  `currentWorkspace()?.background || '#ffffff'`.
- `applyWorkspaceCanvas`: вызывать `state.board.setBackground(...)`.
- `bindBoardSize`: `change` → `workspace_background {color}`; «Сброс» → `null`.
- `handleServerEvent`: case `workspace_background` обновляет workspace и
  применяет цвет при совпадении страницы.
- `handleWorkspaceState`: сохранять `message.background` у не-презентаций.

- [ ] **Step 6: Прогнать E2E и проверить тёмный фон**

Run: `npx playwright test tests/board-size.spec.js tests/presentations.spec.js`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add frontend/index.html frontend/css/room.css frontend/js/board.js \
  frontend/js/main.js e2e/tests/board-size.spec.js
git commit -m "feat: per-page canvas color for teachers"
```

---

### Task 4: Документация и полная регрессия

**Files:**
- Modify: `README.md`
- Modify: `plan.md`

- [ ] **Step 1: Обновить README и plan.md**

README: панель слайдов ниже слайда; цвет холста доступен staff, хранится
постранично, виден ученикам и попадает в PDF.
`plan.md`: P16, критерий 18, таблица, журнал и числа тестов.

- [ ] **Step 2: Полная регрессия**

```bash
cd backend
..\.venv\Scripts\python.exe -m pytest -q -p no:warnings
..\.venv\Scripts\python.exe -m ruff check .
..\.venv\Scripts\python.exe -m black --check .
cd ..\e2e
$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'
npx playwright test
cd ..
docker compose config --quiet
```

Expected: все тесты зелёные, линтеры чистые, compose без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: slide controls and canvas color"
```
