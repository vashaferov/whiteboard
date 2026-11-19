# Ластик для всех объектов, Ctrl+Z и лассо: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить ластик удалять любые доступные элементы, починить `Ctrl+Z` в любой раскладке и добавить лассо с групповым перемещением/удалением и одной записью истории.

**Architecture:** `Ctrl+Z` определяется по `event.code`. Ластик в `Board.eraseAt` обходит все объекты и использует их геометрию. Лассо живёт в `Board`: рамка на overlay-слое, набор `selectedIds`, общий Transformer и групповой drag; удаление/перемещение группы идут новыми batch-сообщениями, чтобы сервер записал одну запись истории.

**Tech Stack:** Vanilla JS, Konva.js, FastAPI/Pydantic, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-eraser-ctrlz-lasso-design.md`

## Global Constraints

- Ластик и лассо подчиняются правам удаления/правки: ученик — свои незаблокированные, staff — любые незаблокированные.
- Фрейм ластиком — только по границе; лассо выбирает группы (фигуры/текст/картинки/фреймы), не штрихи/коннекторы.
- Групповое действие — одна запись истории, один `Ctrl+Z`.
- Презентации: лассо недоступно, ластик staff стирает пометки.
- Новых зависимостей нет; формат снимков не меняется.
- Backend-тесты: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.
- Перед мержем — разрешение пользователя.

## Review Focus

- `Ctrl+Z` при русской раскладке (`key: 'я', code: 'KeyZ'`) и в редакторе текста.
- Ластик не удаляет чужое/заблокированное; фрейм не исчезает при стирании внутри.
- Лассо не выбирает штрихи, чужие и заблокированные объекты.
- Групповой drag не двигает детей фрейма дважды и обновляет коннекторы.
- Групповое удаление/перемещение отменяется одним `Ctrl+Z`.

---

## Структура файлов

- `backend/app/models/schemas.py` — `ObjectsDelete`, `ObjectsMove`.
- `backend/app/api/ws.py` — batch-обработчики, каскад, одна запись истории.
- `backend/tests/test_batch_actions.py` — права, каскад, undo.
- `frontend/js/main.js` — `Ctrl+Z` по `code`, Delete для группы, вызовы batch.
- `frontend/js/board.js` — геометрия ластика, `selectedIds`, лассо, group drag.
- `frontend/js/tools.js` — лассо не рисует.
- `frontend/index.html`, `frontend/css/room.css` — кнопка лассо.
- `e2e/tests/eraser-lasso.spec.js` — новые сценарии.
- `e2e/tests/board-undo-lock.spec.js` — Ctrl+Z в раскладке.
- `README.md`, `plan.md`.

---

### Task 1: Ctrl+Z в любой раскладке

**Files:**
- Modify: `frontend/js/main.js:1750-1755`
- Test: `e2e/tests/board-undo-lock.spec.js`

**Interfaces:**
- Produces: отмена по `event.code === 'KeyZ'` при Ctrl/Meta, без Shift.

- [ ] **Step 1: Добавить падающий E2E**

В `board-undo-lock.spec.js` после существующего Ctrl+Z теста:

```js
test('undo: ctrl+z works with a Cyrillic keyboard layout', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo layout', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);
  await drawRect(page, { x: 720, y: 400 }, { x: 900, y: 520 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'я',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => objectCount(page)).toBe(0);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx.cmd playwright test tests/board-undo-lock.spec.js -g "Cyrillic" --timeout=30000`
Expected: FAIL — объект остаётся.

- [ ] **Step 3: Исправить обработчик**

```js
    if (event.ctrlKey || event.metaKey) {
      if (event.code === 'KeyZ' && !event.shiftKey) {
        event.preventDefault();
        requestUndo();
      }
      return;
    }
```

- [ ] **Step 4: Прогнать**

Run: `npx.cmd playwright test tests/board-undo-lock.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 5: Коммит**

```bash
git add frontend/js/main.js e2e/tests/board-undo-lock.spec.js
git commit -m "fix: trigger undo by physical KeyZ"
```

---

### Task 2: Batch-удаление и перемещение на сервере

**Files:**
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/api/ws.py`
- Test: `backend/tests/test_batch_actions.py`

**Interfaces:**
- Produces: `ObjectsDelete {type, objectIds: list[str]}` (1–200),
  `ObjectsMove {type, updates: list[{objectId,x,y}]}` (1–200).
- Produces: одна запись истории на batch; клиентам уходят обычные
  `object_delete`/`object_update`.

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/tests/test_batch_actions.py`:

```python
"""Групповые удаление и перемещение."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until, shape


def test_batch_delete_cascades_and_undoes_once(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        for object_id in ("a", "b", "c"):
            tw.send_json(shape(object_id))
            barrier(tw)

        tw.send_json({"type": "objects_delete", "objectIds": ["a", "b"]})
        deleted = {m["objectId"] for m in barrier(tw) if m["type"] == "object_delete"}
        assert deleted == {"a", "b"}

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        assert {obj["object"]["id"] for obj in restored["objects"]} == {"a", "b"}
        assert "c" not in {obj["object"]["id"] for obj in restored["objects"]}


def test_batch_delete_respects_permissions_and_locks(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(shape("own"))
        recv_until(sw, "shape_add")
        tw.send_json({"type": "object_lock", "objectId": "own", "locked": True})
        recv_until(sw, "object_lock")

        sw.send_json({"type": "objects_delete", "objectIds": ["own"]})
        assert "locked" in codes(barrier(sw))


def test_batch_move_is_one_history_entry(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        for object_id in ("a", "b"):
            tw.send_json(shape(object_id))
            barrier(tw)

        tw.send_json(
            {
                "type": "objects_move",
                "updates": [
                    {"objectId": "a", "x": 300, "y": 300},
                    {"objectId": "b", "x": 400, "y": 400},
                ],
            }
        )
        moved = {m["objectId"] for m in barrier(tw) if m["type"] == "object_update"}
        assert moved == {"a", "b"}

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        by_id = {obj["object"]["id"]: obj["object"] for obj in restored["objects"]}
        assert (by_id["a"]["x"], by_id["a"]["y"]) == (10, 20)
        assert (by_id["b"]["x"], by_id["b"]["y"]) == (10, 20)
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_batch_actions.py -q -p no:warnings`
Expected: FAIL — неизвестные сообщения.

- [ ] **Step 3: Схемы**

```python
class MoveEntry(BaseModel):
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class ObjectsDelete(_Message):
    type: Literal["objects_delete"]
    objectIds: list[str] = Field(min_length=1, max_length=200)


class ObjectsMove(_Message):
    type: Literal["objects_move"]
    updates: list[MoveEntry] = Field(min_length=1, max_length=200)
```

Добавить в union и импорты `ws.py`.

- [ ] **Step 4: Обработчики**

`_handle_objects_delete`: для каждого id получить объект в текущей странице;
пропустить отсутствующие; если `_locked_for(room, obj)` — ошибка `locked`;
если нет прав на удаление (включая проверку чужих детей фрейма) — `forbidden`;
собрать `targets` + `_deletion_cascade`, без дублей; если пусто — вернуть;
`_push_delete(manager, room, user, targets)` один раз; удалить все; разослать
`object_delete` на каждый id (exclude автора).

`_handle_objects_move`: для каждого update получить объект; пропустить
недоступные/заблокированные; собрать `moved`; если пусто — вернуть;
`_push_fields(manager, room, user, moved_objects, ("x", "y", "frameId"))` один раз;
для каждого вызвать `update_object`, `_attach_to_frame`, разослать
`object_update`; для фрейма дополнительно сдвинуть детей на ту же дельту
(вычислить из старой позиции до обновления) и разослать их `object_update`.

Добавить ветки диспетчера.

- [ ] **Step 5: Прогнать**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_batch_actions.py tests/test_board_undo_lock.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 6: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/api/ws.py backend/tests/test_batch_actions.py
git commit -m "feat: add batched delete and move"
```

---

### Task 3: Ластик для всех объектов

**Files:**
- Modify: `frontend/js/board.js` (`eraseAt`, вспомогательная геометрия)
- Test: `e2e/tests/eraser-lasso.spec.js`

**Interfaces:**
- Produces: `Board.eraseAt(point, radius)` возвращает id всех удалённых объектов.

- [ ] **Step 1: Написать падающий E2E**

```js
import { expect, test } from '@playwright/test';

import { drawRect, lessonSetup, objectCount, openRoom, signInWith, worldToScreen } from '../helpers.js';

async function eraseAt(page, point) {
  await page.click('[data-tool="eraser"]');
  const screen = await worldToScreen(page, point);
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.up();
}

test('eraser removes shapes, text and images but keeps a frame interior', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser everything', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 600, y: 300 }, { x: 800, y: 420 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await eraseAt(page, { x: 700, y: 360 });
  await expect.poll(() => objectCount(page)).toBe(0);
});
```

Дополнить тест: создать фрейм и прямоугольник внутри, стереть прямоугольник
изнутри (фрейм остаётся), затем стереть фрейм по границе (исчезает).
Для текста: создать текст в центре и стереть по его координатам.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx.cmd playwright test tests/eraser-lasso.spec.js -g "eraser removes" --timeout=30000`
Expected: FAIL — фигура остаётся.

- [ ] **Step 3: Обобщить `eraseAt`**

```js
  eraseAt(point, radius) {
    const ids = [];
    for (const [id, entry] of [...this.objects.entries()]) {
      if (!this.deletePredicate(entry.data)) continue;
      if (entry.data.type === 'stroke' && !this._isErased(entry, point, radius)) continue;
      if (entry.data.type === 'frame' && !this._nearFrameBorder(entry.data, point, radius)) {
        continue;
      }
      if (!['stroke', 'frame'].includes(entry.data.type)) {
        const rect = entry.node.getClientRect({ relativeTo: this.contentLayer });
        const near = {
          x: Math.max(rect.x, Math.min(point.x, rect.x + rect.width)),
          y: Math.max(rect.y, Math.min(point.y, rect.y + rect.height)),
        };
        if (Math.hypot(near.x - point.x, near.y - point.y) > radius) continue;
      }
      ids.push(id);
    }
    for (const id of ids) this.removeObject(id);
    return ids;
  }
```

- [ ] **Step 4: Прогнать**

Run: `npx.cmd playwright test tests/eraser-lasso.spec.js -g "eraser" --timeout=30000`
Expected: все passed.

- [ ] **Step 5: Коммит**

```bash
git add frontend/js/board.js e2e/tests/eraser-lasso.spec.js
git commit -m "feat: let the eraser remove any editable object"
```

---

### Task 4: Лассо, групповой drag и удаление

**Files:**
- Modify: `frontend/index.html` (кнопка `data-tool="lasso"`)
- Modify: `frontend/js/tools.js` (лассо не рисует)
- Modify: `frontend/js/board.js` (лассо, selectedIds, group drag)
- Modify: `frontend/js/main.js` (Delete, batch-вызовы)
- Modify: `frontend/css/room.css`
- Test: `e2e/tests/eraser-lasso.spec.js`

**Interfaces:**
- Produces: `Board.setLassoMode(enabled)`, `Board.selectObjects(ids)`,
  `Board.getSelectedIds()`.
- Consumes: `objects_delete`, `objects_move` (Task 2).

- [ ] **Step 1: Написать падающий E2E**

```js
test('lasso selects, moves and deletes a group with one undo', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Lasso', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 600, y: 300 }, { x: 700, y: 380 });
  await drawRect(page, { x: 760, y: 300 }, { x: 860, y: 380 });
  await expect.poll(() => objectCount(page)).toBe(2);

  await page.click('[data-tool="lasso"]');
  const from = await worldToScreen(page, { x: 560, y: 260 });
  const to = await worldToScreen(page, { x: 900, y: 420 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();

  const selected = await page.evaluate(
    () => window.Konva.stages[0].findOne('Transformer').nodes().length,
  );
  expect(selected).toBe(2);

  const dragFrom = await worldToScreen(page, { x: 650, y: 340 });
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 80, dragFrom.y + 60, { steps: 10 });
  await page.mouse.up();

  await page.keyboard.press('Delete');
  await expect.poll(() => objectCount(page)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => objectCount(page)).toBe(2);
});
```

Добавить проверку ученика: чужие объекты в рамку не попадают и не удаляются.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx.cmd playwright test tests/eraser-lasso.spec.js -g "lasso" --timeout=30000`
Expected: FAIL — нет `[data-tool="lasso"]`.

- [ ] **Step 3: Кнопка и режим**

В док после `select`:

```html
<button class="tool" data-tool="lasso" title="Лассо (L)" aria-label="Лассо">
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 6h14v12H5z" stroke-dasharray="3 3" />
    <path d="M5 6l-1-2M19 18l1 2" />
  </svg>
</button>
```

`ToolManager.setTool`: для `lasso` вызывать `board.setLassoMode(true)`, для
остальных `false`; `_handleDown` возвращает при `tool === 'lasso'`.

- [ ] **Step 4: Выделение и рамка**

В `Board`:

```js
  setLassoMode(enabled) {
    this.lassoMode = enabled;
    if (!enabled) this.hideLasso();
  }

  getSelectedIds() {
    return [...this.selectedIds];
  }

  selectObjects(ids) {
    this.selectedIds = new Set(ids);
    this.selectedId = ids[ids.length - 1] ?? null;
    this.syncTransformer();
    this.onSelectObject?.(this.selectedId);
    this.contentLayer.batchDraw();
  }
```

`syncTransformer`: `nodes` из `selectedIds`; resize/rotate включать только для
одного объекта; при нескольких — только перемещение.

`_handleStagePointerDown` при `lassoMode`: если попали в выбранный объект —
ничего (drag начнёт Konva); иначе начать рамку в мировых координатах.
`_trackPointerMove/Up` обновляют/завершают рамку; по завершении:

```js
      const ids = [];
      for (const [id, entry] of this.objects) {
        if (!(entry.node instanceof Konva.Group)) continue;
        if (!this.editPredicate(entry.data, entry.node)) continue;
        if (!this.rectsIntersect(lassoRect, entry.node.getClientRect({ relativeTo: this.contentLayer }))) {
          continue;
        }
        ids.push(id);
      }
      this.selectObjects(this.dropFrameChildren(ids));
```

`dropFrameChildren`: убрать объекты, чей `frameId` принадлежит выбранному фрейму.

- [ ] **Step 5: Групповой drag**

В `_applyDraggable` при нескольких выбранных:

- `dragstart`: запомнить позиции всех выбранных;
- `dragmove`: сместить остальные на дельту перетаскиваемого; для фрейма
  дополнительно не двигать выбранных детей (они уже в наборе) — дедупликация;
- `dragend`: собрать `updates` для всех затронутых объектов (фрейм + дети +
  выбранные) и вызвать `onObjectsMove(updates)`.

В `main.js`:

```js
    onObjectsMove: (updates) => sendWorkspace({ type: 'objects_move', updates }),
```

- [ ] **Step 6: Удаление группы**

В `bindKeyboard` для Delete/Backspace:

```js
      const ids = state.board?.getSelectedIds?.() ?? [];
      if (ids.length > 1) {
        event.preventDefault();
        const objects = ids.map((id) => state.board.getObjectData(id)).filter(Boolean);
        if (objects.some((object) => !canDeleteObject(object))) {
          toast('Некоторые элементы удалить нельзя');
          return;
        }
        if (objects.some((object) => object.type === 'frame') &&
            !window.confirm('Удалить выбранные элементы вместе с содержимым?')) return;
        state.board.removeObjects(ids);
        sendWorkspace({ type: 'objects_delete', objectIds: ids });
        return;
      }
```

`removeObjects` в `Board` удаляет узлы и обновляет выбор.

- [ ] **Step 7: Прогнать E2E**

Run: `npx.cmd playwright test tests/eraser-lasso.spec.js tests/board-undo-lock.spec.js tests/permissions.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add frontend/index.html frontend/js/tools.js frontend/js/board.js frontend/js/main.js frontend/css/room.css e2e/tests/eraser-lasso.spec.js
git commit -m "feat: add the lasso tool for group actions"
```

---

### Task 5: Документация и регрессия

- [ ] **Step 1: README** — ластик удаляет любые доступные элементы, фрейм — по
  границе; лассо и групповые действия; `Ctrl+Z` работает в любой раскладке.
- [ ] **Step 2: plan.md** — P15, критерий 17, журнал, проверки, числа.
- [ ] **Step 3: Регрессия** — backend, ruff/black, полный Playwright,
  `docker compose config --quiet`.
- [ ] **Step 4: Коммит документации и запрос разрешения на merge.**

## Self-Review

- **Спека → задачи:** Ctrl+Z (1), batch-протокол (2), ластик (3), лассо (4),
  документация (5).
- **Review Focus → тесты:** раскладка (1), каскад/права/undo (2), фрейм и типы
  (3), выбор/чужое/групповой drag/undo (4).
- **Типы:** `objects_delete/objects_move`, `selectedIds`, `getSelectedIds`,
  `selectObjects`, `removeObjects`, `onObjectsMove` согласованы.
- **Пропорция:** подробно описаны только batch-история и геометрия лассо.
