# Шрифты текста и две правки холста: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить выбор системного шрифта для объектов «Текст», вернуть панорамирование холста мышью при увеличенном масштабе и сохранить постраничную историю отмены при переключении страниц.

**Architecture:** Шрифт хранится коротким ключом `fontFamily` в объекте `text`, проверяется Pydantic-типом, разворачивается клиентом в CSS-стек и меняется отдельным сообщением `text_font` с записью в историю полей. Панорамирование добавляется как перетаскивание пустого места/средней кнопкой/`Space+протяжка` поверх существующих колеса и pinch. Из `switch_workspace` убирается очистка истории: стеки уже разделены по `(user_id, workspace_id)`.

**Tech Stack:** FastAPI, Pydantic v2, pytest, ванильный JS, Konva.js, CSS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-text-fonts-design.md`

## Global Constraints

- Шрифты только у объектов `text`; блоки, стрелки, фреймы и изображения не меняются.
- Пять ключей: `sans`, `serif`, `mono`, `hand`, `narrow`; отсутствие поля = `sans`; внешних загрузок нет.
- Новых зависимостей нет; русские подписи, существующий стиль кода.
- Панорама работает только при масштабе > 100%; колесо и pinch сохраняются.
- История остаётся личной и постраничной; очищается при `clear`, удалении страницы, кике и выходе.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.
- Перед мержем — отдельный запрос разрешения пользователю.

## Review Focus

- Старый текст без `fontFamily` рисуется обычным шрифтом и не ломает снимки.
- Ученик не может сменить шрифт чужого/заблокированного текста; учитель может.
- Смена шрифта отменяется и возвращает прежнее значение.
- Перетаскивание пустого места не рисует штрих и не сдвигает объект; короткий клик снимает выделение.
- Отмена на странице A после ухода на B и возврата убирает действие A, не трогая B.

---

## Структура файлов

- `backend/app/models/schemas.py` — тип ключа шрифта, поле в `TextAdd`, сообщение `TextFont`.
- `backend/app/api/ws.py` — создание текста с полем, обработчик `text_font`, диспетчеризация.
- `backend/app/services/room_manager.py` — убрать очистку истории из `switch_workspace`.
- `backend/tests/test_text_fonts.py` — новые backend-тесты шрифтов.
- `backend/tests/test_board_undo_lock.py` — отмена после переключения страниц.
- `backend/tests/test_presentations_ws.py` — запрет `text_font` на презентации.
- `frontend/js/board.js` — стеки шрифтов, отрисовка текста, `setTextFont`, перетаскивание холста.
- `frontend/js/tools.js` — текущий шрифт в `getTextStyle`.
- `frontend/js/main.js` — селект шрифта, редактор текста, обработка `text_font`.
- `frontend/index.html`, `frontend/css/style.css` — разметка и курсоры.
- `e2e/tests/text-fonts.spec.js` — новый E2E шрифтов.
- `e2e/tests/workspaces.spec.js` — E2E отмены после смены страницы.
- `e2e/tests/zoom.spec.js` — E2E перетаскивания холста.
- `README.md`, `plan.md` — документация.

---

### Task 1: Backend шрифтов

**Files:**
- Modify: `backend/app/models/schemas.py` (около `TextAdd`, `TextUpdate`, union `ClientMessage`)
- Modify: `backend/app/api/ws.py` (`_handle_text_add`, диспетчер, новый `_handle_text_font`)
- Test: `backend/tests/test_text_fonts.py`, `backend/tests/test_presentations_ws.py`

**Interfaces:**
- Produces: `TEXT_FONT_VALUES = ("sans", "serif", "mono", "hand", "narrow")`,
  `TextFontFamily = Literal["sans", "serif", "mono", "hand", "narrow"]`.
- Produces: `TextAdd.fontFamily: TextFontFamily = "sans"`.
- Produces: `TextFont` (`type: Literal["text_font"]`, `objectId`, `fontFamily`).
- Produces: объект `text` содержит `fontFamily`; broadcast `text_font`
  содержит `objectId`, `fontFamily`, `workspaceId`.

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/tests/test_text_fonts.py`:

```python
"""Шрифты объектов «Текст»."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, flush, recv_until, shape


def text(object_id: str = "t1", **overrides) -> dict:
    payload = {
        "type": "text_add",
        "objectId": object_id,
        "content": "Текст",
        "x": 10,
        "y": 20,
        "color": "#111827",
        "fontSize": 24,
    }
    payload.update(overrides)
    return payload


def test_text_created_with_font_and_default(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        tw.send_json(text("t1", fontFamily="serif"))
        assert recv_until(sw, "text_add")["object"]["fontFamily"] == "serif"

        tw.send_json(text("t2"))
        assert recv_until(sw, "text_add")["object"]["fontFamily"] == "sans"

        tw.send_json(text("t3", fontFamily="comic"))
        assert codes(barrier(tw)) == ["invalid_message"]


def test_font_change_permissions_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(text("t1"))
        recv_until(sw, "text_add")

        sw.send_json({"type": "text_font", "objectId": "t1", "fontFamily": "mono"})
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json({"type": "text_font", "objectId": "t1", "fontFamily": "mono"})
        changed = recv_until(sw, "text_font")
        assert changed["objectId"] == "t1"
        assert changed["fontFamily"] == "mono"

        tw.send_json(shape("s1"))
        recv_until(sw, "shape_add")
        tw.send_json({"type": "text_font", "objectId": "s1", "fontFamily": "serif"})
        assert codes(barrier(tw)) == ["not_text"]

        tw.send_json({"type": "object_lock", "objectId": "t1", "locked": True})
        recv_until(sw, "object_lock")
        sw.send_json({"type": "text_font", "objectId": "t1", "fontFamily": "narrow"})
        assert "locked" in codes(barrier(sw))

        tw.send_json({"type": "text_font", "objectId": "t1", "fontFamily": "narrow"})
        assert recv_until(sw, "text_font")["fontFamily"] == "narrow"


def test_font_change_is_undoable(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", fontFamily="serif"))
        barrier(tw)
        tw.send_json({"type": "text_font", "objectId": "t1", "fontFamily": "mono"})
        barrier(tw)

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        assert restored["removedIds"] == []
        assert restored["objects"][0]["object"]["fontFamily"] == "serif"

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["t1"]
```

В `test_presentation_permissions` (в `test_presentations_ws.py`) рядом с проверкой `shape_add` добавить:

```python
        tw.send_json({"type": "text_font", "objectId": "text-1", "fontFamily": "serif"})
        assert "presentation_view_only" in codes(barrier(tw))
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_text_fonts.py -q -p no:warnings`
Expected: FAIL — неизвестное сообщение `text_font`, нет поля `fontFamily`.

- [ ] **Step 3: Добавить типы и сообщение**

В `backend/app/models/schemas.py` рядом с `TextAdd`:

```python
TEXT_FONT_VALUES = ("sans", "serif", "mono", "hand", "narrow")
TextFontFamily = Literal["sans", "serif", "mono", "hand", "narrow"]
```

В `TextAdd` добавить:

```python
    fontFamily: TextFontFamily = "sans"
```

После `TextUpdate`:

```python
class TextFont(_Message):
    type: Literal["text_font"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    fontFamily: TextFontFamily
```

Добавить `| TextFont` в `ClientMessage` рядом с `| TextUpdate`.

- [ ] **Step 4: Создавать текст с полем и обрабатывать `text_font`**

В `_handle_text_add` передать `fontFamily=message.fontFamily` в `_new_object`.

В диспетчере после `TextUpdate` добавить:

```python
    elif isinstance(message, TextFont):
        await _handle_text_font(manager, room, user, message)
```

После `_handle_text_update` добавить обработчик:

```python
async def _handle_text_font(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: TextFont,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if obj.get("type") != "text":
        await manager.send_to(user, _error("not_text", "Объект не является текстом"))
        return
    if _locked_for(user, room, obj):
        await manager.send_to(user, _error("locked", "Объект заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно менять только свой текст"))
        return
    _push_fields(manager, room, user, [obj], ("fontFamily",))
    manager.update_object_fields(room, message.objectId, fontFamily=message.fontFamily)
    await manager.broadcast(
        room,
        {
            "type": "text_font",
            "objectId": message.objectId,
            "fontFamily": message.fontFamily,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )
```

Импортировать `TextFont` рядом с остальными схемами.

- [ ] **Step 5: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_text_fonts.py tests/test_presentations_ws.py tests/test_ws.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 6: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/api/ws.py backend/tests/test_text_fonts.py backend/tests/test_presentations_ws.py
git commit -m "feat: add text font families to the protocol"
```

---

### Task 2: Клиент шрифтов и E2E

**Files:**
- Modify: `frontend/js/board.js` (`FONT_STACKS`, `_createTextNode`, новый `setTextFont`)
- Modify: `frontend/js/tools.js` (`fontFamily`, `getTextStyle`, сеттер)
- Modify: `frontend/index.html` (селект шрифта)
- Modify: `frontend/js/main.js` (редактор, селект, обработка события)
- Modify: `frontend/css/style.css` (стиль селекта)
- Test: `e2e/tests/text-fonts.spec.js`

**Interfaces:**
- Consumes: `TextAdd.fontFamily`, `TextFont`, broadcast `text_font` (Task 1).
- Produces: `export const FONT_STACKS`, `export function fontStack(key)` в `board.js`.
- Produces: `Board.setTextFont(objectId, fontFamily)`.
- Produces: DOM `#font-select` внутри `.font-control`; `ToolManager.getTextStyle()`
  возвращает `{ color, fontSize, fontFamily }`.

- [ ] **Step 1: Написать падающий E2E**

Создать `e2e/tests/text-fonts.spec.js`:

```js
import { expect, test } from '@playwright/test';

import { lessonSetup, objectCount, openRoom, reloadAndWait, signInWith, worldToScreen } from '../helpers.js';

function textFont(page) {
  return page.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[1].findOne('Text');
    return node ? node.fontFamily() : null;
  });
}

test('text: font applies to new and selected text and is shared', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Fonts' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await teacher.click('[data-tool="text"]');
  await teacher.selectOption('#font-select', 'serif');
  const point = await worldToScreen(teacher, { x: 320, y: 240 });
  await teacher.mouse.click(point.x, point.y);
  await teacher.fill('#text-editor', 'Заголовок');
  await teacher.press('#text-editor', 'Enter');
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await expect.poll(() => textFont(teacher)).toContain('Georgia');
  await expect.poll(() => textFont(student)).toContain('Georgia');

  await teacher.click('[data-tool="select"]');
  await teacher.mouse.click(point.x + 12, point.y + 12);
  await expect(teacher.locator('#font-select')).toHaveValue('serif');
  await teacher.selectOption('#font-select', 'mono');
  await expect.poll(() => textFont(teacher)).toContain('Consolas');
  await expect.poll(() => textFont(student)).toContain('Consolas');

  await reloadAndWait(teacher);
  await expect(teacher.locator('#font-select')).toBeHidden();
  await expect.poll(() => textFont(teacher)).toContain('Consolas');

  await teacherContext.close();
  await studentContext.close();
});
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/text-fonts.spec.js --timeout=30000`
Expected: FAIL — нет `#font-select` и `fontFamily` у Konva.Text.

- [ ] **Step 3: Добавить стеки и отрисовку**

В `frontend/js/board.js` рядом с `FONT_FAMILY`:

```js
export const FONT_STACKS = {
  sans: FONT_FAMILY,
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace',
  hand: '"Segoe Script", "Comic Sans MS", cursive',
  narrow: '"Arial Narrow", "Liberation Sans Narrow", sans-serif',
};

export function fontStack(fontFamily) {
  return FONT_STACKS[fontFamily] ?? FONT_STACKS.sans;
}
```

В `_createTextNode` заменить `fontFamily: FONT_FAMILY` на
`fontFamily: fontStack(object.fontFamily)`.

Добавить метод рядом с `applyObjectTransform`:

```js
  setTextFont(objectId, fontFamily) {
    const entry = this.objects.get(objectId);
    if (!entry || entry.data.type !== 'text') return;
    entry.data.fontFamily = fontFamily;
    entry.node.findOne('Text')?.fontFamily(fontStack(fontFamily));
    this.contentLayer.batchDraw();
  }
```

- [ ] **Step 4: Добавить текущий шрифт в ToolManager**

В `frontend/js/tools.js` в конструкторе: `this.fontFamily = 'sans';`.

```js
  setFontFamily(fontFamily) {
    this.fontFamily = fontFamily;
  }

  getTextStyle() {
    return {
      color: this.color,
      fontSize: Math.min(96, Math.max(16, Math.round(this.width * 6))),
      fontFamily: this.fontFamily,
    };
  }
```

- [ ] **Step 5: Разметка и стили**

В `frontend/index.html` после `#colors`:

```html
        <label class="font-control" title="Шрифт" hidden>
          <select id="font-select" aria-label="Шрифт">
            <option value="sans">Обычный</option>
            <option value="serif">С засечками</option>
            <option value="mono">Моноширинный</option>
            <option value="hand">Рукописный</option>
            <option value="narrow">Узкий</option>
          </select>
        </label>
```

В `frontend/css/style.css` рядом с `.width-control`:

```css
.font-control select {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 13px;
}
```

- [ ] **Step 6: Подключить селект и редактор**

В `frontend/js/main.js`:

- импорт: `import { Board, fontStack } from './board.js';`
- константы подписей не нужны — подписи в HTML.
- в `cacheElements`: `els.fontControl = $('#font-select')?.closest('.font-control'); els.fontSelect = $('#font-select');`
- в `bindToolbar()` добавить:

```js
  els.fontSelect?.addEventListener('change', () => {
    const fontFamily = els.fontSelect.value;
    state.tools?.setFontFamily(fontFamily);
    const id = state.board?.getSelectedId();
    const object = id ? state.board.getObjectData(id) : null;
    if (isPresentation() || !object || object.type !== 'text' || !canEditObject(object)) {
      return;
    }
    state.board.setTextFont(id, fontFamily);
    sendWorkspace({ type: 'text_font', objectId: id, fontFamily });
    updateFontControl();
  });
```

- новая функция:

```js
function updateFontControl() {
  if (!els.fontControl) return;
  const presentation = isPresentation();
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  const selected = object?.type === 'text' && !presentation ? object : null;
  const visible = Boolean(selected) || (!presentation && state.tool === 'text');
  els.fontControl.hidden = !visible;
  if (!visible) return;
  els.fontSelect.value = selected
    ? selected.fontFamily || 'sans'
    : state.tools?.fontFamily || 'sans';
  els.fontSelect.disabled = Boolean(selected) && !canEditObject(selected);
}
```

- вызывать `updateFontControl()` в конце `updateToolbar()`, в `selectTool()` после `state.tool = tool` и в `onSelectObject` рядом с `updateFramePanel()`.
- `showTextEditorAt(x, y, fontSize, color, value, fontFamily = 'sans')` — установить
  `els.textEditor.style.fontFamily = fontStack(fontFamily);`
- в `openTextEditorForObject` передать `object.fontFamily`; в `beginTextAt` — `style.fontFamily`.
- в `finishText` добавить `fontFamily: style.fontFamily` в объект и в `text_add`.
- в переключателе `applyWorkspaceEvent` добавить `case 'text_font':`:

```js
    case 'text_font':
      board.setTextFont(message.objectId, message.fontFamily);
      updateFontControl();
      break;
```

- [ ] **Step 7: Прогнать E2E**

Run: `npx.cmd playwright test tests/text-fonts.spec.js --timeout=30000`
Expected: `1 passed`.

- [ ] **Step 8: Коммит**

```bash
git add frontend/js/board.js frontend/js/tools.js frontend/js/main.js frontend/index.html frontend/css/style.css e2e/tests/text-fonts.spec.js
git commit -m "feat: choose font family for text objects"
```

---

### Task 3: Перетаскивание холста

**Files:**
- Modify: `frontend/js/board.js` (`panDrag`, `_startPan`, `_updatePan`, `_setPan`, `isGesturing`, `setSelectMode`)
- Modify: `frontend/css/style.css` (курсоры)
- Test: `e2e/tests/zoom.spec.js`

**Interfaces:**
- Produces: `Board._setPan(panX, panY)`, `Board.setSelectMode` добавляет класс
  `is-pannable`; `Board.isGesturing()` истинно и во время панорамирования.
- Consumes: существующие `panBy`, `_clampView`, `_applyView`, `zoom`.

- [ ] **Step 1: Написать падающий E2E**

Добавить в `e2e/tests/zoom.spec.js`:

```js
test('dragging the empty canvas pans a zoomed board', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.click('[data-tool="select"]');
  const before = await stageView(page);
  const box = await page.locator('#board-stage').boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 160, start.y - 120, { steps: 10 });
  await page.mouse.up();
  const after = await stageView(page);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(10);
  expect(after.scaleX).toBeCloseTo(before.scaleX, 3);
});
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/zoom.spec.js -g "dragging" --timeout=30000`
Expected: FAIL — позиция stage не меняется.

- [ ] **Step 3: Разделить `panBy` на установку и сдвиг**

В `frontend/js/board.js`:

```js
  _setPan(panX, panY) {
    if (this.zoom <= 1) return;
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    this.panX = panX;
    this.panY = panY;
    this._clampView(containerWidth, containerHeight);
    this._applyView(containerWidth, containerHeight);
  }

  panBy(dx, dy) {
    this._setPan(this.panX + dx, this.panY + dy);
  }
```

- [ ] **Step 4: Начать и завершить перетаскивание**

В конструкторе: `this.panDrag = null; this.spaceHeld = false;`, порог `PAN_THRESHOLD = 4`
на уровне модуля. Добавить слушатели `keydown`/`keyup` на `window`, которые ставят
`this.spaceHeld` для `event.code === 'Space'`, если цель не `INPUT`, `TEXTAREA`, `SELECT`
и не `isContentEditable`; снимать в `destroy()`.

В `_handleStagePointerDown(event)` в начале:

```js
    const native = event.evt;
    const empty = event.target === this.stage || event.target === this.paper;
    if (this.zoom > 1 && (native.button === 1 || this.spaceHeld || (native.button === 0 && this.selectMode && empty))) {
      native.preventDefault();
      this.panDrag = {
        id: native.pointerId,
        startX: native.clientX,
        startY: native.clientY,
        panX: this.panX,
        panY: this.panY,
        moved: false,
      };
      this.container.setPointerCapture?.(native.pointerId);
      if (empty) this.selectObject(null);
      return;
    }
```

`isGesturing()` сделать `Boolean(this.gesture || this.panDrag)`.

В `_trackPointerMove` первым делом:

```js
    if (this.panDrag && this.panDrag.id === event.pointerId) {
      const drag = this.panDrag;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
      drag.moved = true;
      this.container.classList.add('is-panning');
      this._setPan(drag.panX + dx, drag.panY + dy);
      return;
    }
```

В `_trackPointerUp` перед работой с touch:

```js
    if (this.panDrag && this.panDrag.id === event.pointerId) {
      this.container.releasePointerCapture?.(event.pointerId);
      this.container.classList.remove('is-panning');
      this.panDrag = null;
    }
```

- [ ] **Step 5: Курсоры**

В `_applyView` добавить
`this.container.classList.toggle('is-pannable', this.zoom > 1 && this.selectMode);`,
в `setSelectMode` — ту же строку после присваивания `this.selectMode`.

В `frontend/css/style.css`:

```css
.board__stage.is-pannable {
  cursor: grab;
}

.board__stage.is-panning {
  cursor: grabbing;
}
```

- [ ] **Step 6: Прогнать E2E**

Run: `npx.cmd playwright test tests/zoom.spec.js tests/board-elements.spec.js --timeout=30000`
Expected: все passed (включая прежние сценарии рисования и выделения).

- [ ] **Step 7: Коммит**

```bash
git add frontend/js/board.js frontend/css/style.css e2e/tests/zoom.spec.js
git commit -m "fix: pan the zoomed board by dragging"
```

---

### Task 4: История отмены переживает смену страницы

**Files:**
- Modify: `backend/app/services/room_manager.py:712-723`
- Test: `backend/tests/test_board_undo_lock.py`
- Test: `e2e/tests/workspaces.spec.js`

**Interfaces:**
- Produces: `switch_workspace` не трогает `room.history`; стеки остаются
  по ключу `(user_id, workspace_id)`.

- [ ] **Step 1: Написать падающий backend-тест**

Переименовать `test_undo_empty_and_cleared_by_switch` в `test_undo_empty` (он не
переключает страницы) и добавить в `test_board_undo_lock.py`:

```python
def test_undo_survives_workspace_switch(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(shape("first"))
        barrier(tw)

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        second = recv_until(tw, "workspace_created")["workspace"]["id"]
        recv_until(tw, "workspace_state")
        tw.send_json(shape("second"))
        barrier(tw)

        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        recv_until(tw, "workspace_state")
        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["first"]

        tw.send_json({"type": "workspace_switch", "workspaceId": second})
        recv_until(tw, "workspace_state")
        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["second"]
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py::test_undo_survives_workspace_switch -q -p no:warnings`
Expected: FAIL — после возврата приходит `undo_empty`.

- [ ] **Step 3: Убрать очистку истории**

В `RoomManager.switch_workspace` удалить строку `self.clear_history(room, user.id)`.
Историю по-прежнему очищают `clear`, удаление страницы, кик и выход.

- [ ] **Step 4: Прогнать backend-тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py tests/test_workspaces_ws.py tests/test_room_manager.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 5: Написать падающий E2E**

Добавить в `e2e/tests/workspaces.spec.js`:

```js
test('undo works after leaving and returning to a page', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo across pages', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 300, y: 300 }, { x: 420, y: 390 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await createPage(page, 'Вторая');
  await drawRect(page, { x: 500, y: 300 }, { x: 620, y: 390 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await selectPage(page, 'Страница 1');
  await expect.poll(() => objectCount(page)).toBe(1);
  await page.click('#undo-btn');
  await expect.poll(() => objectCount(page)).toBe(0);

  await selectPage(page, 'Вторая');
  await expect.poll(() => objectCount(page)).toBe(1);
  await page.click('#undo-btn');
  await expect.poll(() => objectCount(page)).toBe(0);
});
```

- [ ] **Step 6: Прогнать E2E**

Run: `npx.cmd playwright test tests/workspaces.spec.js -g "undo works" --timeout=30000`
Expected: `1 passed`.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/services/room_manager.py backend/tests/test_board_undo_lock.py e2e/tests/workspaces.spec.js
git commit -m "fix: keep undo history across page switches"
```

---

### Task 5: Документация и полная регрессия

**Files:**
- Modify: `README.md`
- Modify: `plan.md`

- [ ] **Step 1: Обновить README**

- В строке про отмену убрать «до смены страницы»: история личная, постраничная,
  живёт до перезагрузки или выхода; после возврата на страницу отмена работает.
- В возможностях текста: «пять системных шрифтов (обычный, с засечками, моноширинный,
  рукописный, узкий); выбор — для нового и выделенного текста».
- В строке про масштаб: «холст перетаскивается мышью (пустое место в режиме «Выбор»,
  средняя кнопка или `Space+протяжка`), колесом и двумя пальцами».
- Блоки схемы/стрелки/фреймы — шрифт не меняется.

- [ ] **Step 2: Обновить plan.md**

- Раздел `### P12. Шрифты текста и правки холста ✅` с чекбоксами.
- Пункт 14 в критериях готовности.
- Строка в журнале реализации.
- Блок «Проверка шрифтов и правок (эта итерация)».
- Актуальные числа тестов после прогона; в локальной команде — новое число.

- [ ] **Step 3: Полная регрессия**

- `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings` → все passed.
- `backend`: `ruff check .` и `black --check .` → чисто.
- `e2e`: `npx.cmd playwright test` → все passed.
- `docker compose config --quiet` → 0.

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: text fonts and canvas fixes"
```

- [ ] **Step 5: Спросить разрешение на merge**

Остановиться и спросить пользователя, можно ли мержить ветку в `main` и деплоить.
Не мержить до явного ответа.

---

## Self-Review

- **Спека:** шрифты (Task 1–2), панорамирование (Task 3), история при смене
  страницы (Task 4), документация (Task 5).
- **Review Focus → тесты:** старый текст без поля (Task 1 default), права и замок
  (Task 1), отмена шрифта (Task 1), drag vs клик (Task 3 E2E + прежние тесты
  выделения), изоляция страниц (Task 4 backend + E2E).
- **Типы:** `fontFamily` одинаков в схеме, `_handle_text_font`, `text_font` broadcast,
  `board.setTextFont`, `fontStack`; `FONT_STACKS` — единственный источник стеков.
- **Пропорция:** тела функций приведены только там, где без них остаётся выбор
  (панорама, права); тесты задают ожидаемое поведение.
