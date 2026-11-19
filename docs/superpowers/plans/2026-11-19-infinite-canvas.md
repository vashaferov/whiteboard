# Бесконечный холст и авторазмер презентаций: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать обычные страницы бесконечными с режимом фиксированной страницы по выбору staff, экспортировать PDF по границам контента и подгонять холст презентации под натуральный размер слайда.

**Architecture:** Режим холста хранится в метаданных workspace (`canvas`; отсутствие = бесконечный). `Board` получает два режима viewport: бесконечный (100% = 1:1, свободная панорама, сетка по окну, «вписать» по объектам) и фиксированный (прежний лист). Презентация временно включает фиксированный холст по натуральному JPEG слайда; PDF снимает объединённые границы объектов.

**Tech Stack:** Vanilla JS, Konva.js, FastAPI/Pydantic, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-infinite-canvas-design.md`

## Global Constraints

- Обычные страницы по умолчанию бесконечные; фиксированный режим — только по выбору staff.
- Презентации всегда подстраиваются под слайд; панель размера для них скрыта.
- PDF всегда по границам контента, независимо от текущего зума и панорамы.
- Новых зависимостей нет; существующие обработчики, `data-tool`, `#pages-panel`,
  `#users-panel`, `#zoom-controls`, `#slide-controls` сохраняются.
- Координаты объектов расширяются до ±1 000 000.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.
- Перед мержем — отдельный запрос разрешения.

## Review Focus

- Панорама за пределы старого листа и рисование там; «Вписать» возвращает весь контент.
- Пустая бесконечная страница показывает район старой доски, а не пустоту.
- Переключение страниц применяет их режим и не тащит чужой зум.
- PDF не зависит от вида и включает все объекты, включая стрелки/фреймы/изображения.
- Презентация занимает весь слайд без полей, а после выхода страница снова бесконечная.
- Старые снимки без `canvas` открываются бесконечными, фиксированные страницы сохраняются.

---

## Структура файлов

- `backend/app/services/workspaces.py` — нормализация `canvas`, бесконечность по умолчанию.
- `backend/app/models/schemas.py` — `WorkspaceCanvas`, лимиты координат.
- `backend/app/api/ws.py` — обработчик `workspace_canvas`, рассылка, init.
- `backend/app/services/room_manager.py` — создание страниц без `canvas`, Redis-синхронизация.
- `backend/tests/test_workspace_canvas.py` — новый набор.
- `backend/tests/test_ws.py` — расширенные координаты.
- `frontend/js/board.js` — режимы viewport, сетка, `fitContent`, экспорт по контенту,
  авторазмер презентации.
- `frontend/js/main.js` — метаданные canvas, панель, переключение страниц, презентация.
- `frontend/index.html`, `frontend/css/room.css` — панель «Холст страницы».
- `e2e/tests/infinite-canvas.spec.js`, `board-size.spec.js`, `zoom.spec.js`,
  `clipboard-pdf.spec.js`, `presentations.spec.js`.
- `README.md`, `plan.md` — документация.

---

### Task 1: Метаданные холста страницы

**Files:**
- Modify: `backend/app/services/workspaces.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/api/ws.py`
- Test: `backend/tests/test_workspace_canvas.py`, `backend/tests/test_ws.py`

**Interfaces:**
- Produces: `normalize_canvas(raw) -> dict | None`; отсутствие canvas = `infinite`.
- Produces: `WorkspaceCanvas {type: "workspace_canvas", mode, width?, height?}`.
- Produces: сервер→клиент `workspace_canvas {workspaceId, canvas}`; `canvas` отсутствует
  для бесконечной страницы (или `null`).
- Produces: `COORD_MIN = -1_000_000`, `COORD_MAX = 1_000_000`.

- [ ] **Step 1: Написать падающие backend-тесты**

Создать `backend/tests/test_workspace_canvas.py`:

```python
"""Режим холста страницы."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def test_workspace_canvas_defaults_to_infinite(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        init = tw.receive_json()
        assert "canvas" not in init["workspaces"][0]
        barrier(tw)

        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 1200, "height": 800})
        changed = recv_until(tw, "workspace_canvas")
        assert changed["canvas"] == {"mode": "fixed", "width": 1200, "height": 800}

        tw.send_json({"type": "workspace_canvas", "mode": "infinite"})
        assert recv_until(tw, "workspace_canvas")["canvas"] is None


def test_workspace_canvas_permissions_and_validation(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        sw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 900, "height": 700})
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json({"type": "workspace_canvas", "mode": "fixed"})
        assert "invalid_message" in codes(barrier(tw))
        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 4000, "height": 500})
        assert "invalid_message" in codes(barrier(tw))


def test_workspace_canvas_is_per_page(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 1200, "height": 800})
        recv_until(tw, "workspace_canvas")

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        second = recv_until(tw, "workspace_created")["workspace"]
        recv_until(tw, "workspace_state")
        assert "canvas" not in second

        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        state = recv_until(tw, "workspace_state")
        first = next(ws for ws in state["workspaces"] if ws["id"] == "ws_default")
        assert first["canvas"] == {"mode": "fixed", "width": 1200, "height": 800}
```

В `test_ws.py` добавить проверку новых границ:

```python
def test_coordinates_allow_infinite_canvas_range(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json({**SHAPE, "objectId": "far", "x": 999_999, "y": -999_999})
        assert "invalid_message" not in codes(barrier(tw))
        tw.send_json({**SHAPE, "objectId": "too-far", "x": 1_000_001, "y": 0})
        assert "invalid_message" in codes(barrier(tw))
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspace_canvas.py -q -p no:warnings`
Expected: FAIL — неизвестное сообщение `workspace_canvas`.

- [ ] **Step 3: Добавить нормализацию canvas**

В `workspaces.py`:

```python
CANVAS_MIN = 640
CANVAS_MAX = 4000
CANVAS_RATIO = 4


def normalize_canvas(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("mode") != "fixed":
        return None
    try:
        width = int(raw["width"])
        height = int(raw["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (CANVAS_MIN <= width <= CANVAS_MAX and CANVAS_MIN <= height <= CANVAS_MAX):
        return None
    if max(width / height, height / width) > CANVAS_RATIO:
        return None
    return {"mode": "fixed", "width": width, "height": height}
```

В `normalize_workspaces` для обычных страниц:

```python
        canvas = normalize_canvas(item.get("canvas"))
        if canvas is not None:
            workspace["canvas"] = canvas
```

Презентации `canvas` не получают. `default_workspace()` не меняется — отсутствие
`canvas` и означает бесконечность.

- [ ] **Step 4: Добавить сообщение и обработчик**

Схема:

```python
class WorkspaceCanvas(_Message):
    type: Literal["workspace_canvas"]
    mode: Literal["infinite", "fixed"]
    width: int | None = Field(default=None, ge=640, le=4000)
    height: int | None = Field(default=None, ge=640, le=4000)
```

Добавить в `ClientMessage` и импорт в `ws.py`. Обработчик:

```python
async def _handle_workspace_canvas(manager, room, user, message) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Менять холст может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    workspace = room.get_workspace(user.workspace_id)
    if workspace is None or workspace.get("kind") == PRESENTATION_KIND:
        await manager.send_to(user, _error("invalid_message", "Холст презентации задаёт слайд"))
        return
    canvas = None
    if message.mode == "fixed":
        if message.width is None or message.height is None:
            await manager.send_to(user, _error("invalid_message", "Укажите ширину и высоту"))
            return
        ratio = max(message.width / message.height, message.height / message.width)
        if ratio > 4:
            await manager.send_to(user, _error("invalid_message", "Слишком вытянутый холст"))
            return
        canvas = {"mode": "fixed", "width": message.width, "height": message.height}
    if canvas is None:
        workspace.pop("canvas", None)
    else:
        workspace["canvas"] = canvas
    manager.mark_dirty(room)
    await manager.broadcast(
        room,
        {
            "type": "workspace_canvas",
            "workspaceId": user.workspace_id,
            "canvas": canvas,
        },
        workspace_id=user.workspace_id,
    )
```

Добавить ветку диспетчера.

- [ ] **Step 5: Redis-синхронизация**

В `_sync_redis_event` добавить `workspace_canvas` в ветку, которая вызывает
`_write_workspaces`. В `_apply_remote_event` обработать:

```python
        elif kind == "workspace_canvas":
            workspace_id = message.get("workspaceId")
            workspace = room.workspaces.get(workspace_id) if isinstance(workspace_id, str) else None
            if workspace is not None:
                canvas = message.get("canvas")
                if isinstance(canvas, dict):
                    workspace["canvas"] = canvas
                else:
                    workspace.pop("canvas", None)
                changed = True
```

- [ ] **Step 6: Поднять лимиты координат**

В `schemas.py`: `COORD_MIN = -1_000_000.0`, `COORD_MAX = 1_000_000.0`.

- [ ] **Step 7: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspace_canvas.py tests/test_ws.py tests/test_workspaces.py tests/test_workspaces_ws.py tests/test_redis.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add backend/app/services/workspaces.py backend/app/models/schemas.py backend/app/api/ws.py backend/app/services/room_manager.py backend/tests/test_workspace_canvas.py backend/tests/test_ws.py
git commit -m "feat: add per-page infinite canvas mode"
```

---

### Task 2: Панель «Холст страницы» и режим страницы на клиенте

**Files:**
- Modify: `frontend/index.html`, `frontend/css/room.css`
- Modify: `frontend/js/main.js`
- Test: `e2e/tests/board-size.spec.js` (переписать)

**Interfaces:**
- Consumes: `workspace.canvas`, `workspace_canvas` (Task 1).
- Produces: `state.workspaces[].canvas`; DOM `#canvas-infinite`;
  `applyWorkspaceCanvas(workspace)`, `updateBoardSizePanel()`.

- [ ] **Step 1: Переписать E2E страницы**

Заменить `e2e/tests/board-size.spec.js`:

```js
import { expect, test } from '@playwright/test';

import { createPage, lessonSetup, openRoom, reloadAndWait, selectPage, signInWith } from '../helpers.js';

function paper(page) {
  return page.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[0].getChildren()[0];
    return { width: node.width(), height: node.height(), visible: node.visible() };
  });
}

test('page canvas switches between infinite and fixed and remembers the mode', async ({
  page,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Page canvas', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  expect((await paper(page)).visible).toBe(false);

  await page.click('#room-more');
  await page.click('#board-size-btn');
  await page.uncheck('#canvas-infinite');
  await page.fill('#board-width', '1200');
  await page.fill('#board-height', '800');
  await page.click('#board-size-apply');
  await expect.poll(() => paper(page)).toEqual({ width: 1200, height: 800, visible: true });

  await page.reload();
  await expect(page.locator('#status')).toHaveText('Подключено');
  expect(await paper(page)).toEqual({ width: 1200, height: 800, visible: true });

  await createPage(page, 'Вторая');
  expect((await paper(page)).visible).toBe(false);

  await selectPage(page, 'Страница 1');
  expect(await paper(page)).toEqual({ width: 1200, height: 800, visible: true });
});
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/board-size.spec.js --timeout=30000`
Expected: FAIL — нет `#canvas-infinite`, бумага видима по умолчанию.

- [ ] **Step 3: Разметка панели**

В `frontend/index.html` переименовать `#board-size-btn` в «Холст страницы» и
добавить в панель перед полями:

```html
                <label class="board-size-panel__field">
                  <input id="canvas-infinite" type="checkbox" checked />
                  Бесконечный холст
                </label>
```

- [ ] **Step 4: Логика панели**

В `main.js`:

```js
function currentWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.workspaceId) || null;
}

function workspaceCanvas(workspace) {
  return workspace?.canvas || { mode: 'infinite' };
}

function applyWorkspaceCanvas(workspace = currentWorkspace()) {
  if (!state.board) return;
  if (workspace?.kind === 'presentation') return;
  const canvas = workspaceCanvas(workspace);
  if (canvas.mode === 'fixed') {
    state.board.setCanvasMode('fixed', canvas.width, canvas.height);
  } else {
    state.board.setCanvasMode('infinite');
  }
}
```

`updateBoardSizePanel`:

```js
function updateBoardSizePanel() {
  if (!els.boardSizePanel || els.boardSizePanel.hidden) return;
  const canvas = workspaceCanvas(currentWorkspace());
  const infinite = canvas.mode !== 'fixed';
  els.canvasInfinite.checked = infinite;
  els.boardWidth.value = String(canvas.width ?? 1600);
  els.boardHeight.value = String(canvas.height ?? 900);
  els.boardWidth.disabled = infinite;
  els.boardHeight.disabled = infinite;
  for (const preset of document.querySelectorAll('[data-board-preset]')) {
    preset.disabled = infinite;
  }
}
```

`bindBoardSize` при применении:

```js
    const mode = els.canvasInfinite.checked ? 'infinite' : 'fixed';
    sendWorkspace({
      type: 'workspace_canvas',
      mode,
      width: mode === 'fixed' ? width : undefined,
      height: mode === 'fixed' ? height : undefined,
    });
    els.boardSizePanel.hidden = true;
```

Пресеты и поля включают чекбокс (`els.canvasInfinite.checked = false`) при выборе
размера.

- [ ] **Step 5: Применять режим при входе и переключении**

- В `handleInit`: после `state.workspaces = message.workspaces` вызвать
  `applyWorkspaceCanvas(currentWorkspace())` вместо `setBoardSize(message.board...)`.
- В `handleWorkspaceState`: после обновления `state.workspaceId` вызвать
  `applyWorkspaceCanvas(currentWorkspace())`.
- Новый обработчик:

```js
    case 'workspace_canvas': {
      const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
      if (workspace) {
        if (message.canvas) workspace.canvas = message.canvas;
        else delete workspace.canvas;
      }
      if (message.workspaceId === state.workspaceId) applyWorkspaceCanvas(workspace);
      updateBoardSizePanel();
      break;
    }
```

- [ ] **Step 6: Переименовать подписи и стили**

Кнопка меню — «Холст страницы»; чекбокс — в стиле `.board-size-panel__field`
(добавить `gap`, `cursor: pointer`, `white-space: nowrap` в `room.css`).

- [ ] **Step 7: Прогнать E2E**

Run: `npx.cmd playwright test tests/board-size.spec.js tests/workspaces.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add frontend/index.html frontend/css/room.css frontend/js/main.js e2e/tests/board-size.spec.js
git commit -m "feat: switch a page between infinite and fixed canvas"
```

---

### Task 3: Бесконечный viewport и сетка

**Files:**
- Modify: `frontend/js/board.js`
- Test: `e2e/tests/infinite-canvas.spec.js`, `e2e/tests/zoom.spec.js`

**Interfaces:**
- Produces: `Board.setCanvasMode(mode, width?, height?)`,
  `Board.fitContent()`, `Board.contentBounds()`.
- Produces: `this.canvasMode`, `this.width/height`; при `infinite` бумага скрыта,
  сетка рисуется по видимому окну.

- [ ] **Step 1: Написать падающий E2E**

Создать `e2e/tests/infinite-canvas.spec.js`:

```js
import { expect, test } from '@playwright/test';

import { lessonSetup, objectCount, openRoom, reloadAndWait, signInWith } from '../helpers.js';

test('infinite page pans past the old sheet, keeps drawing and fits content', async ({
  page,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Infinite canvas', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  const paperVisible = await page.evaluate(
    () => window.Konva.stages[0].getLayers()[0].getChildren()[0].visible(),
  );
  expect(paperVisible).toBe(false);

  const box = await page.locator('#board-stage').boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 600, center.y + 400, { steps: 12 });
  await page.mouse.up();

  await page.click('[data-tool="brush"]');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(1);

  await page.click('#zoom-reset');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stage = window.Konva.stages[0];
        return { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
      }),
    )
    .not.toEqual({ x: 0, y: 0, scale: 1 });

  await reloadAndWait(page);
  await expect.poll(() => objectCount(page)).toBe(1);
});
```

Обновить `zoom.spec.js`: на бесконечной странице `100%` — это `stage.scaleX() === 1`;
«вписать» после рисования даёт масштаб, отличный от 100%; рисование после зума,
колесо и pinch проверяются по `stageView`.

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/infinite-canvas.spec.js --timeout=30000`
Expected: FAIL — бумага видима, панорама ограничена.

- [ ] **Step 3: Ввести режим в `Board`**

В конструкторе: `this.canvasMode = 'fixed'; this.presentation = false;`.

```js
  setCanvasMode(mode, width = this.width, height = this.height) {
    const changed = mode !== this.canvasMode || width !== this.width || height !== this.height;
    this.canvasMode = mode;
    this.width = width;
    this.height = height;
    this.paper.size({ width, height });
    this.paper.visible(mode === 'fixed' && !this.presentation);
    this.grid.size({ width, height });
    if (changed) this.resetView();
  }
```

- [ ] **Step 4: Формулы viewport**

```js
  layout() {
    if (this.destroyed) return;
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    this.fitScale =
      this.canvasMode === 'fixed'
        ? Math.max(MIN_SCALE, Math.min(cw / this.width, ch / this.height))
        : 1;
    this._clampView(cw, ch);
    this._applyView(cw, ch);
  }

  _applyView(cw, ch) {
    const scale = this.canvasMode === 'fixed' ? this.fitScale * this.zoom : this.zoom;
    this.scale = scale;
    if (this.canvasMode === 'fixed') {
      this.offsetX = (cw - this.width * scale) / 2 + this.panX;
      this.offsetY = (ch - this.height * scale) / 2 + this.panY;
    } else {
      this.offsetX = cw / 2 + this.panX;
      this.offsetY = ch / 2 + this.panY;
    }
    ...
    this._updateGrid(cw, ch, scale);
  }
```

`_clampView` для `infinite` очищает ограничения:

```js
    if (this.canvasMode === 'infinite') return;
```

`_setPan`: для бесконечной страницы работает при любом зуме:

```js
    if (this.canvasMode === 'fixed' && this.zoom <= 1) return;
```

`setZoom`: минимум `0.1` для infinite, `0.5` для fixed; при якоре:

```js
      const base = this.canvasMode === 'fixed'
        ? (cw - this.width * scale) / 2
        : cw / 2;
      this.panX = anchor.x - world.x * scale - base;
```

`resetView`:

```js
  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    if (this.canvasMode === 'infinite' && !this.presentation) this.fitContent();
    else this.layout();
  }
```

`fitContent`:

```js
  contentBounds() {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const entry of this.objects.values()) {
      const rect = entry.node.getClientRect({ relativeTo: this.contentLayer });
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }
    if (!Number.isFinite(left)) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  fitContent() {
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    const bounds = this.contentBounds();
    if (!bounds) {
      this.zoom = 1;
      this.panX = -800;
      this.panY = -450;
      this._applyView(cw, ch);
      return;
    }
    const padding = Math.max(40, Math.max(bounds.width, bounds.height) * 0.1);
    const zoom = clamp(
      Math.min((cw - padding * 2) / bounds.width, (ch - padding * 2) / bounds.height),
      0.1,
      MAX_ZOOM,
    );
    this.zoom = zoom;
    this.panX = -(bounds.x + bounds.width / 2) * zoom;
    this.panY = -(bounds.y + bounds.height / 2) * zoom;
    this._applyView(cw, ch);
  }
```

- [ ] **Step 5: Бесконечная сетка**

`_updateGrid(cw, ch, scale)`:

```js
  _updateGrid(cw, ch, scale) {
    if (this.canvasMode === 'fixed') {
      this.grid.position({ x: 0, y: 0 });
      this.grid.size({ width: this.width, height: this.height });
      return;
    }
    const step = gridStep(scale);
    const left = -this.offsetX / scale;
    const top = -this.offsetY / scale;
    const x0 = Math.floor(left / step) * step;
    const y0 = Math.floor(top / step) * step;
    this.grid.position({ x: x0, y: y0 });
    this.grid.size({
      width: (cw / scale) + step * 2,
      height: (ch / scale) + step * 2,
    });
    this.grid._gridStep = step;
  }
```

`gridStep(scale)`: начать с 32 и удваивать, пока `step*scale < 12`, и делить, пока
`step*scale > 64` (минимум 4). `sceneFunc` сетки берёт `this._gridStep || 32` и
рисует точки от `0` до `width/height` с этим шагом. Для фиксированной страницы
шаг 32.

В `_applyView` вызывать `_updateGrid` вместо ручного `grid.size`; сетка видима,
когда `canvasMode === 'fixed'` и `!presentation` (фиксированная страница) или
`canvasMode === 'infinite'` (точечная сетка). На презентации `grid.visible(false)`.

- [ ] **Step 6: Курсор панорамирования**

`_applyView`: `is-pannable` включать при `selectMode` и (`canvasMode === 'infinite'`
или `zoom > 1`). Перетаскивание пустого места начинает панораму без условия
`zoom > 1`, если режим бесконечный.

- [ ] **Step 7: Прогнать E2E**

Run: `npx.cmd playwright test tests/infinite-canvas.spec.js tests/zoom.spec.js tests/ui-polish.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add frontend/js/board.js e2e/tests/infinite-canvas.spec.js e2e/tests/zoom.spec.js
git commit -m "feat: add the infinite board viewport"
```

---

### Task 4: PDF по границам контента

**Files:**
- Modify: `frontend/js/board.js` (`exportCanvas`)
- Modify: `frontend/js/export.js`
- Test: `e2e/tests/clipboard-pdf.spec.js`

**Interfaces:**
- Produces: `Board.exportCanvas() -> {canvas, width, height}` (мировые размеры области).
- Consumes: `Board.contentBounds()`.

- [ ] **Step 1: Обновить E2E PDF**

В `clipboard-pdf.spec.js` после рисования прямоугольника проверить, что MediaBox
соответствует пропорциям контента, а не старым 16:9:

```js
  const match = /\/MediaBox \[0 0 960 ([\d.]+)\]/.exec(text);
  expect(match).not.toBeNull();
  const height = Number(match[1]);
  expect(height).toBeGreaterThan(400);
  expect(height).toBeLessThan(1100);
```

Добавить отдельную проверку: на бесконечной странице нарисовать объект далеко
(панорамой), экспорт всё равно содержит один объект.

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js -g "pdf" --timeout=30000`
Expected: FAIL — MediaBox остаётся `[0 0 960 540]`.

- [ ] **Step 3: Экспорт по bounds**

```js
  async exportCanvas() {
    ...
    const bounds = this.contentBounds();
    if (!bounds) throw new Error('Нет объектов');
    const padding = Math.max(32, Math.max(bounds.width, bounds.height) * 0.03);
    const left = bounds.x - padding;
    const top = bounds.y - padding;
    const width = bounds.width + padding * 2;
    const height = bounds.height + padding * 2;
    const pixelRatio = Math.min(2, 8000 / Math.max(width, height, 1));
    ...
      this.paper.visible(false);
      stage.size({ width: Math.ceil(width), height: Math.ceil(height) });
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: -left, y: -top });
      stage.draw();
      return {
        canvas: stage.toCanvas({ pixelRatio }),
        width,
        height,
      };
```

Для белого фона добавить временный `Konva.Rect` в `backgroundLayer` с
`{x: left, y: top, width, height, fill: '#fff', listening: false}` и уничтожить
его в `finally`. Сохранять/восстанавливать `paper.visible()`.

- [ ] **Step 4: Обновить `exportWorkspacePdf`**

```js
export async function exportWorkspacePdf(board, name) {
  const { canvas, width, height } = await board.exportCanvas();
  ...
  const page = pdfPageSize(width, height);
```

- [ ] **Step 5: Прогнать E2E**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 6: Коммит**

```bash
git add frontend/js/board.js frontend/js/export.js e2e/tests/clipboard-pdf.spec.js
git commit -m "feat: export PDF by content bounds"
```

---

### Task 5: Холст презентации по размеру слайда

**Files:**
- Modify: `frontend/js/board.js` (`setPresentationSlide`, `clearPresentationSlide`)
- Modify: `frontend/js/main.js` (`applyWorkspaceMode`, exit)
- Test: `e2e/tests/presentations.spec.js`

**Interfaces:**
- Produces: `Board.presentation`; при показе слайда `canvasMode='fixed'`,
  `width/height = naturalWidth/Height`, бумага скрыта, сетка скрыта.

- [ ] **Step 1: Обновить E2E презентации**

В `presentations.spec.js` после показа первого слайда:

```js
  const slide = await teacher.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[0].findOne('.slide-bg');
    return {
      width: node.width(),
      height: node.height(),
      canvasVisible: window.Konva.stages[0].getLayers()[0].getChildren()[0].visible(),
      grid: window.Konva.stages[0].getLayers()[0].getChildren()[1].visible(),
    };
  });
  expect(slide.canvasVisible).toBe(false);
  expect(slide.grid).toBe(false);
  expect(slide.width).toBe(1600);
```

(Точные ширина/высота берутся из натурального JPEG фикстуры; если он не 1600 —
сравнить с `naturalWidth` первого изображения.)

После возврата на обычную страницу:

```js
  const paperVisible = await teacher.evaluate(
    () => window.Konva.stages[0].getLayers()[0].getChildren()[0].visible(),
  );
  expect(paperVisible).toBe(false); // страница бесконечная
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/presentations.spec.js --timeout=30000`
Expected: FAIL — слайд вписан с полями, бумага видима.

- [ ] **Step 3: Подгонять холст при показе слайда**

В `setPresentationSlide` после загрузки изображения:

```js
    this.presentation = true;
    this.setCanvasMode('fixed', image.naturalWidth, image.naturalHeight);
    this.paper.visible(false);
    this.grid.visible(false);
    const node = new Konva.Image({
      name: 'slide-bg',
      image,
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
      listening: false,
    });
```

`setCanvasMode` при `presentation` не показывает бумагу и не сбрасывает вид
дважды: после установки размеров вызвать `this.fit()`.

В `clearPresentationSlide`:

```js
    this.presentation = false;
    this.grid.visible(true);
    // Режим страницы восстановит main.js через applyWorkspaceCanvas().
```

- [ ] **Step 4: Восстановление страницы**

В `main.js` в ветке выхода из презентации (где `wasPresentation`) вызвать
`applyWorkspaceCanvas(currentWorkspace())` после `clearPresentationSlide()`.
При входе в презентацию `applyWorkspaceMode` вызывает `setPresentationSlide`,
который сам задаёт размер; `applyWorkspaceCanvas` для презентации ничего не делает.

- [ ] **Step 5: Прогнать E2E**

Run: `npx.cmd playwright test tests/presentations.spec.js tests/board-size.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 6: Коммит**

```bash
git add frontend/js/board.js frontend/js/main.js e2e/tests/presentations.spec.js
git commit -m "feat: fit the presentation canvas to the slide"
```

---

### Task 6: Документация и полная регрессия

**Files:**
- Modify: `README.md`, `plan.md`

- [ ] **Step 1: README**

- Обычные страницы бесконечные: свободная панорама, 100% = реальный масштаб,
  «вписать» по объектам; фиксированный лист включается в «Ещё → Холст страницы».
- PDF — по границам содержимого с отступом.
- Презентации — холст по размеру слайда, без полей и сетки.
- Обновить строку про размер холста и экспорт.

- [ ] **Step 2: plan.md**

- P14 «Бесконечный холст и авторазмер презентаций ✅».
- Пункт 16 в критериях готовности.
- Строка в журнале и блок проверки с фактическими числами.
- Команда локального прогона с новым числом тестов.

- [ ] **Step 3: Полная регрессия**

- `backend`: `pytest -q -p no:warnings`; `ruff`; `black --check`.
- `e2e`: весь Playwright.
- `docker compose config --quiet`.

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: infinite canvas and presentation sizing"
```

- [ ] **Step 5: Спросить разрешение на merge**

---

## Self-Review

- **Спека → задачи:** режим страницы (Task 1–2), бесконечный viewport и сетка
  (Task 3), PDF по контенту (Task 4), презентации (Task 5), документация (Task 6).
- **Review Focus → тесты:** панорама/рисование за листом и fit (Task 3 E2E),
  пустая страница (Task 3), режимы страниц и перезагрузка (Task 2 E2E),
  PDF-пропорции и объект вне вида (Task 4), слайд без полей и возврат (Task 5).
- **Типы:** `canvas` в workspace, `WorkspaceCanvas`, `workspace_canvas`,
  `setCanvasMode`, `applyWorkspaceCanvas`, `exportCanvas` согласованы по именам;
  отсутствие `canvas` = `infinite` на сервере и клиенте.
- **Пропорция:** формулы viewport и fit приведены полностью, потому что задают
  семантику; остальное — сигнатуры и тесты.
