# Ластик по кисти, отмена действий и блокировка: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ластик стирает только штрихи кисти, кнопка отмены возвращает моё последнее действие (включая удаление), учитель блокирует элементы от любых изменений учеником.

**Architecture:** Ластик фильтруется на клиенте. Замок — поле `locked` на объекте и серверная проверка во всех изменяющих обработчиках, с наследованием от фрейма. Отмена — личный серверный стек снимков (затронутые поля; полные объекты для удаления), событие `objects_restored` синхронизирует результат через WebSocket и Redis.

**Tech Stack:** FastAPI, Pydantic v2, WebSocket, Redis (sync между инстансами), Konva.js, Playwright, pytest, ruff/black.

**Spec:** `docs/superpowers/specs/2026-11-17-undo-eraser-lock-design.md`

## Global Constraints

- Новых зависимостей не добавлять; Python 3.13, `.venv` в корне репозитория.
- Все WS-сообщения — Pydantic-модели с `extra="forbid"`; добавлять их в `ClientMessage`.
- Изменяющие состояние события обязаны синхронизироваться через Redis (`room_manager`).
- Объектные события фильтруются по `workspaceId`; broadcast — с `workspace_id=user.workspace_id`.
- Пользовательские тексты (тосты, ошибки) — на русском.
- Код и тесты — в стиле текущих файлов; комментарии — по-русски.
- Backend-тесты запускать из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E запускать из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/board-undo-lock.spec.js`.
- Backend-тесты и E2E не запускать одновременно.
- Субагентов не использовать (указание партнёра); ревью — самостоятельное.

## Review Focus

- Чужая правка между действием и отменой: отмена не должна затирать поля, которых не касалась.
- Отмена ученика после того, как учитель заблокировал объект: операция не должна проходить.
- Замок фрейма: ученик не создаёт «прилипший» объект внутри и не вытаскивает детей.
- Восстановление удалённого фрейма/блока: дети и стрелки возвращаются со своими авторами и на места.
- Пустой/неприменимый стек и смена страницы: отмена не должна висеть или применять чужую запись.

---

### Task 1: Ластик стирает только штрихи кисти

**Files:**
- Modify: `frontend/js/board.js:910-949` (`eraseAt` / `_isErased`)
- Test: `e2e/tests/board-undo-lock.spec.js` (create)

**Interfaces:**
- Consumes: `Board.deletePredicate`, `Board.eraseAt(point, radius) -> string[]`
- Produces: `eraseAt` игнорирует всё, кроме `data.type === 'stroke'`; E2E-файл с локальным `drawWithTool`.

- [ ] **Step 1: Написать падающий E2E-тест**

```js
// e2e/tests/board-undo-lock.spec.js
import { expect, test } from '@playwright/test';
import { clickWorld, drawRect, lessonSetup, objectCount, openRoom, signInWith, worldToScreen } from '../helpers.js';

async function drawWithTool(page, tool, from, to) {
  await page.click(`[data-tool="${tool}"]`);
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function eraseAt(page, from, to) {
  await page.click('[data-tool="eraser"]');
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
}

test('eraser: removes brush strokes and leaves other objects', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser strokes', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawWithTool(page, 'brush', { x: 100, y: 100 }, { x: 300, y: 100 });
  await drawRect(page, { x: 400, y: 300 }, { x: 520, y: 380 });
  await drawWithTool(page, 'process', { x: 600, y: 300 }, { x: 720, y: 380 });
  await expect.poll(() => objectCount(page)).toBe(3);

  await eraseAt(page, { x: 450, y: 330 }, { x: 480, y: 350 });
  await expect.poll(() => objectCount(page)).toBe(3);

  await eraseAt(page, { x: 120, y: 95 }, { x: 280, y: 95 });
  await expect.poll(() => objectCount(page)).toBe(2);

  await context.close();
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/board-undo-lock.spec.js`
Expected: FAIL — после стирания по фигуре `objectCount` становится 2, а не 3.

- [ ] **Step 3: Ограничить `eraseAt` штрихами**

В `frontend/js/board.js` в цикле `eraseAt` заменить условие на:

```js
for (const [id, entry] of [...this.objects.entries()]) {
  if (entry.data.type !== 'stroke') continue;
  if (!this.deletePredicate(entry.data)) continue;
  if (this._isErased(entry, point, radius)) ids.push(id);
}
```

`_isErased` и ветки для фреймов/коннекторов/bbox оставить без изменений: они больше не достижимы из ластика, но используются тестами и будущими инструментами.

- [ ] **Step 4: Прогнать тест**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/board-undo-lock.spec.js`
Expected: PASS (1 тест).

- [ ] **Step 5: Коммит**

```bash
git add frontend/js/board.js e2e/tests/board-undo-lock.spec.js
git commit -m "fix: erase only brush strokes"
```

---

### Task 2: Замок на сервере

**Files:**
- Modify: `backend/app/models/schemas.py` (модель `ObjectLock`, `ClientMessage`)
- Modify: `backend/app/api/ws.py` (проверки, `_handle_object_lock`, захват в фрейм)
- Modify: `backend/app/services/room_manager.py` (Redis-событие `object_lock`)
- Test: `backend/tests/test_board_undo_lock.py` (create), `backend/tests/test_redis.py`

**Interfaces:**
- Consumes: `Room.get_object`, `_can_edit_object`, `_attach_to_frame`, `_capture_into_frame`, `_deletion_cascade`, `manager.update_object_fields`, `manager.broadcast`
- Produces:
  - `ObjectLock(_Message)` с `objectId: str`, `locked: bool`
  - `_locked_for(user: ConnectedUser, room: Room, obj: dict[str, Any]) -> bool`
  - `_attach_to_frame(room: Room, obj: dict[str, Any], user: ConnectedUser) -> str | None`
  - `_capture_into_frame(room: Room, frame: dict[str, Any], user: ConnectedUser) -> tuple[list[str], dict[str, Any]]` — второй элемент: прежние `frameId` захваченных детей
  - событие `object_lock` `{objectId, locked, workspaceId}`

- [ ] **Step 1: Написать падающие backend-тесты**

Создать `backend/tests/test_board_undo_lock.py` с импортами:

```python
from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, flush, frame, recv_until, shape
```

Тесты:

```python
def test_student_cannot_change_locked_object(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json(); sw.receive_json(); tw.receive_json()
        tw.send_json({**shape("block"), "shapeType": "process"})
        recv_until(sw, "shape_add")
        tw.send_json({"type": "object_lock", "objectId": "block", "locked": True})
        assert recv_until(sw, "object_lock")["locked"] is True

        sw.send_json({"type": "object_update", "objectId": "block", "x": 90, "y": 90})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_transform", "objectId": "block", "x": 90, "y": 90,
                      "rotation": 0, "width": 60, "height": 50})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "text_update", "objectId": "block", "content": "нельзя"})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "block"})
        assert codes(flush(sw)) == ["locked"]

        tw.send_json({"type": "object_update", "objectId": "block", "x": 90, "y": 90})
        moved = recv_until(sw, "object_update")
        assert (moved["x"], moved["y"]) == (90, 90)


def test_only_staff_can_lock(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json(); sw.receive_json(); tw.receive_json()
        tw.send_json(shape("own"))
        recv_until(sw, "shape_add")
        sw.send_json({"type": "object_lock", "objectId": "own", "locked": True})
        assert codes(flush(sw)) == ["forbidden"]


def test_locked_frame_blocks_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json(); sw.receive_json(); tw.receive_json()
        sw.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(sw))
        recv_until(tw, "frame_add")
        sw.send_json(shape("inner"))
        recv_until(tw, "shape_add")

        tw.send_json({"type": "object_lock", "objectId": "frame-1", "locked": True})
        recv_until(sw, "object_lock")
        sw.send_json({"type": "object_update", "objectId": "inner", "x": 50, "y": 50})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "inner"})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "frame-1"})
        assert codes(flush(sw)) == ["locked"]


def test_student_object_is_not_captured_by_locked_frame(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json(); sw.receive_json(); tw.receive_json()
        tw.send_json(frame("frame-1"))
        recv_until(sw, "frame_add")
        tw.send_json({"type": "object_lock", "objectId": "frame-1", "locked": True})
        recv_until(sw, "object_lock")

        sw.send_json(shape("free"))
        assert "frameId" not in recv_until(tw, "shape_add")["object"]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py -q -p no:warnings`
Expected: FAIL — `object_lock` отклоняется как `invalid_message`.

- [ ] **Step 3: Добавить схему**

В `backend/app/models/schemas.py` после `ObjectDelete`:

```python
class ObjectLock(_Message):
    type: Literal["object_lock"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    locked: bool
```

Добавить `ObjectLock` в union `ClientMessage`.

- [ ] **Step 4: Реализовать проверку и обработчик в `ws.py`**

Добавить после `_can_edit_object`:

```python
def _locked_for(user: ConnectedUser, room: Room, obj: dict[str, Any]) -> bool:
    if is_staff(user.role):
        return False
    if obj.get("locked"):
        return True
    frame_id = obj.get("frameId")
    frame = room.get_object(str(frame_id)) if frame_id else None
    return bool(frame and frame.get("locked"))
```

В `_handle_object_update`, `_handle_object_transform`, `_handle_text_update`, `_handle_frame_move`,
`_handle_frame_style` после проверки `_can_edit_object` добавить:

```python
if _locked_for(user, room, obj):
    await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
    return
```

В `_handle_frame_move` дополнительно для ученика запретить перенос, если любой ребёнок
заблокирован:

```python
if obj.get("type") == "frame" and any(
    _locked_for(user, room, child)
    for child in room.objects
    if child.get("frameId") == obj["id"]
):
    await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
    return
```

(этот блок идёт после персональной проверки фрейма; для стаффа `_locked_for` всегда `False`).

В `_handle_object_delete` после проверки прав и правила фрейма:

```python
if _locked_for(user, room, obj):
    await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
    return
if obj.get("type") == "frame" and not is_staff(user.role):
    children = [child for child in room.objects if child.get("frameId") == obj["id"]]
    if any(_locked_for(user, room, child) for child in children):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
```

Новый обработчик:

```python
async def _handle_object_lock(
    manager: RoomManager, room: Room, user: ConnectedUser, message: ObjectLock
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Блокировать может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None or bool(obj.get("locked")) == message.locked:
        return
    manager.update_object_fields(room, message.objectId, locked=message.locked)
    await manager.broadcast(
        room,
        {
            "type": "object_lock",
            "objectId": message.objectId,
            "locked": message.locked,
            "workspaceId": user.workspace_id,
        },
        workspace_id=user.workspace_id,
    )
```

В `_handle_message` добавить ветку перед `ObjectDelete`:

```python
elif isinstance(message, ObjectLock):
    await _handle_object_lock(manager, room, user, message)
```

- [ ] **Step 5: Запретить захват в заблокированный фрейм**

Изменить `_attach_to_frame` на `(room, obj, user)`; в цикле кандидатов добавить:

```python
if _locked_for(user, room, candidate):
    continue
```

Обновить вызовы в `_handle_shape_add`, `_handle_text_add`, `_handle_image_add`,
`_handle_object_update`, `_handle_object_transform`.

Изменить `_capture_into_frame` на `(room, frame, user)` и возвращать
`tuple[list[str], dict[str, Any]]`: прежние `frameId` детей. Пропускать кандидатов, для которых
`_locked_for(user, room, obj)`, и сразу возвращать `([], {})`, если
`_locked_for(user, room, frame)`. В `_handle_frame_add` распаковать результат; событие
`frame_captured` оставить прежним.

- [ ] **Step 6: Синхронизация замка через Redis**

В `room_manager.py`:

- добавить `"object_lock"` в `WORKSPACE_SCOPED_EVENTS`;
- в `_sync_redis_event` добавить ветку:

```python
elif kind == "object_lock":
    obj = room.get_object(str(message.get("objectId", "")))
    if obj is not None:
        await self._redis.hset(
            objects_key, str(obj["id"]), json.dumps(obj, ensure_ascii=False)
        )
```

- в применении удалённого события (рядом с `object_update`) добавить:

```python
elif kind == "object_lock":
    obj = room.get_object(str(message.get("objectId", "")))
    if obj is not None:
        obj["locked"] = bool(message.get("locked"))
        changed = True
```

- [ ] **Step 7: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py -q -p no:warnings`
Expected: PASS (4 теста).

Run: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
Expected: PASS (187 тестов: 183 + 4).

- [ ] **Step 8: Redis-тест**

В `backend/tests/test_redis.py` добавить тест по образцу `test_frame_moved_is_shared`:

```python
async def test_object_lock_is_shared(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "lock-a", first_redis)
    manager_b = make_manager(settings, tmp_path, "lock-b", second_redis)
    room_a = await manager_a.get_or_create("room-lock")
    room_b = await manager_b.get_or_create("room-lock")

    obj = {"id": "locked", "type": "shape", "shapeType": "rect", "author": "u",
           "workspaceId": "ws_default", "x": 0, "y": 0, "width": 40, "height": 40}
    manager_a.add_object(room_a, obj, "ws_default")
    await manager_a.broadcast(room_a, {"type": "shape_add", "id": "u", "object": obj,
                                       "workspaceId": "ws_default"})
    await wait_for(lambda: room_b.get_object("locked") is not None)

    obj["locked"] = True
    await manager_a.broadcast(room_a, {"type": "object_lock", "objectId": "locked",
                                       "locked": True, "workspaceId": "ws_default"})
    await wait_for(lambda: room_b.get_object("locked").get("locked") is True)
```

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_redis.py -q -p no:warnings`
Expected: PASS.

- [ ] **Step 9: Линтеры и коммит**

Run: `..\.venv\Scripts\python.exe -m ruff check .` и `..\.venv\Scripts\python.exe -m black --check .`
Expected: без ошибок (при необходимости `black .`).

```bash
git add backend/app/models/schemas.py backend/app/api/ws.py backend/app/services/room_manager.py backend/tests/test_board_undo_lock.py backend/tests/test_redis.py
git commit -m "feat: lock board objects for students"
```

---

### Task 3: Серверная история отмены

**Files:**
- Modify: `backend/app/models/schemas.py` (модель `Undo`)
- Modify: `backend/app/services/room_manager.py` (история, `objects_restored`, Redis)
- Modify: `backend/app/api/ws.py` (запись истории, `_handle_undo`, очистка)
- Test: `backend/tests/test_board_undo_lock.py`, `backend/tests/test_redis.py`

**Interfaces:**
- Consumes: модели/обработчики Task 2, `manager.delete_object/add_object`, `_deletion_cascade`, `_capture_into_frame`
- Produces:
  - `Room.history: dict[tuple[str, str], list[dict[str, Any]]]`
  - `RoomManager.push_history(room, user_id, workspace_id, entry, limit=50) -> None`
  - `RoomManager.pop_history(room, user_id, workspace_id) -> dict[str, Any] | None`
  - `RoomManager.clear_history(room, user_id=None, workspace_id=None) -> None`
  - `Undo(_Message)` (только `type` и унаследованный `workspaceId`)
  - событие `objects_restored` `{removedIds: list[str], objects: [{index: int | null, object: dict}], workspaceId}`

Формат записи истории:

```python
{
    "created": ["id"],                                  # удалить при отмене; опционально
    "fields": {"id": {"x": 10, "frameId": None}},       # вернуть поля; опционально
    "deleted": [{"index": 2, "object": {...}}],         # вернуть объекты; опционально
}
```

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/tests/test_board_undo_lock.py` (использовать `deleted`, `drain_until`, `frame`, `shape`):

```python
def restored(messages):
    return [m for m in messages if m["type"] == "objects_restored"]
```

- `test_undo_removes_created_shape`: студент создаёт фигуру, шлёт `{"type":"undo"}`; в
  `flush` есть `objects_restored` с `removedIds == ["s1"]`; наблюдатель при новом подключении
  получает пустой список.
- `test_undo_restores_deleted_shape_with_author`: студент создаёт фигуру; учитель удаляет её;
  учитель шлёт `undo`; `objects_restored.objects[0]["object"]` содержит `id`, `author`
  студента и `index`.
- `test_undo_move_keeps_other_fields`: студент двигает свою фигуру; учитель ставит
  `frame_style` на фрейм студента; студент отменяет движение; объект в событии имеет старые
  `x/y`, а `fill` остаётся учительским.
- `test_undo_frame_creation_releases_children`: учитель рисует прямоугольник, затем фрейм
  вокруг него; `undo` возвращает `removedIds == [frame_id]` и объект-ребёнка с `frameId: null`.
- `test_undo_frame_deletion_restores_children`: учитель создаёт фрейм с ребёнком, удаляет
  фрейм, отменяет; `objects_restored.objects` содержит и фрейм, и ребёнка с прежними авторами.
- `test_undo_block_deletion_restores_arrows`: учитель создаёт блок и стрелку, удаляет блок,
  отменяет; в событии есть и блок, и `connector`.
- `test_undo_skips_stale_entry`: студент создаёт `a1`, затем `a2`; учитель удаляет `a2`;
  студент шлёт `undo`; `removedIds == ["a1"]` (запись про `a2` пропущена).
- `test_undo_empty_and_cleared_by_switch`: `undo` без действий → ошибка `undo_empty`;
  после создания фигуры и `flush` (переключение страницы) `undo` снова `undo_empty`.
- `test_undo_cleared_by_clear`: учитель создаёт фигуру, шлёт `clear`, затем `undo` →
  `undo_empty`.
- `test_undo_skips_locked_object_for_student`: студент создаёт и двигает фигуру, учитель
  блокирует её, студент шлёт `undo` → `undo_empty` (обе записи неприменимы).

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py -q -p no:warnings`
Expected: FAIL — `undo` отклоняется как `invalid_message`.

- [ ] **Step 3: Схема и история**

В `schemas.py`:

```python
class Undo(_Message):
    type: Literal["undo"]
```

Добавить в `ClientMessage`.

В `Room.__init__`: `self.history: dict[tuple[str, str], list[dict[str, Any]]] = {}`.

В `RoomManager` рядом с `delete_object`:

```python
def push_history(self, room, user_id, workspace_id, entry, limit=50):
    stack = room.history.setdefault((user_id, workspace_id), [])
    stack.append(entry)
    del stack[:-limit]

def pop_history(self, room, user_id, workspace_id):
    stack = room.history.get((user_id, workspace_id))
    if not stack:
        return None
    return stack.pop()

def clear_history(self, room, user_id=None, workspace_id=None):
    for key in list(room.history):
        owner, workspace = key
        if user_id is not None and owner != user_id:
            continue
        if workspace_id is not None and workspace != workspace_id:
            continue
        room.history.pop(key, None)
```

- [ ] **Step 4: Помощники записи в `ws.py`**

Добавить импорт `copy` и:

```python
def _push_create(manager, room, user, object_id, fields=None):
    manager.push_history(room, user.id, user.workspace_id,
                         {"created": [object_id], "fields": fields or {}})

def _push_fields(manager, room, user, objects, names):
    fields = {
        str(obj["id"]): {name: copy.deepcopy(obj.get(name)) for name in names}
        for obj in objects if obj is not None
    }
    manager.push_history(room, user.id, user.workspace_id, {"fields": fields})

def _push_delete(manager, room, user, objects):
    deleted = [
        {"index": room.objects.index(obj), "object": copy.deepcopy(obj)}
        for obj in objects if obj in room.objects
    ]
    manager.push_history(room, user.id, user.workspace_id, {"deleted": deleted})
```

- [ ] **Step 5: Записывать историю в обработчиках**

- `_handle_stroke_start`: после `add_object` — `_push_create(..., message.objectId)`.
- `_handle_shape_add`, `_handle_text_add`, `_handle_image_add`, `_handle_connector_add`:
  после успешного добавления — `_push_create`.
- `_handle_frame_add`: использовать второй элемент результата `_capture_into_frame` (прежние
  `frameId` детей) как `fields` в `_push_create(..., obj["id"], previous)`.
- `_handle_object_update`: до `manager.update_object` —
  `_push_fields(..., [obj], ("x", "y", "frameId"))`.
- `_handle_frame_move`: до изменения — `_push_fields` для фрейма и всех детей, поля `("x", "y")`.
- `_handle_object_transform`: до изменения — `_push_fields` для объекта с полями
  `("x", "y", "frameId")`; для текста дополнить `("rotation", "fontSize")`, иначе
  `("width", "height", "rotation")`.
- `_handle_text_update`: до `update_object_fields` — `_push_fields(..., [obj], ("content",))`.
- `_handle_frame_style`: — `_push_fields(..., [obj], ("fill", "pattern"))`.
- `_handle_object_delete`: до каскада собрать `targets = [obj] + cascade objects`, затем
  `_push_delete`.
- `_handle_object_lock`: до изменения — `_push_fields(..., [obj], ("locked",))`.

- [ ] **Step 6: Реализовать `_handle_undo`**

```python
def _undo_fields_apply(user, room, entry) -> bool:
    fields = entry.get("fields") or {}
    applicable = [
        (object_id, patch) for object_id, patch in fields.items()
        if (obj := room.get_object(object_id)) is not None and not _locked_for(user, room, obj)
    ]
    if not applicable:
        return False
    for object_id, patch in applicable:
        room.get_object(object_id).update(copy.deepcopy(patch))
    return True

def _undo_created_apply(user, room, entry) -> list[str] | None:
    created = entry.get("created") or []
    targets = [room.get_object(object_id) for object_id in created]
    targets = [obj for obj in targets if obj is not None]
    if not targets:
        return None
    removed: list[str] = []
    for obj in targets:
        if _locked_for(user, room, obj):
            return None
        cascade = [] if obj.get("type") == "frame" else _deletion_cascade(room, obj)
        removed.extend([str(obj["id"]), *cascade])
    for object_id in removed:
        room.remove_object(object_id)
    for object_id, patch in (entry.get("fields") or {}).items():
        target = room.get_object(object_id)
        if target is not None:
            target.update(copy.deepcopy(patch))
    return removed

def _undo_deleted_apply(user, room, entry) -> tuple[list[str], list[dict]] | None:
    deleted = entry.get("deleted") or []
    absent = [item for item in deleted if room.get_object(str(item["object"]["id"])) is None]
    if not absent:
        return None
    restored = []
    for item in sorted(absent, key=lambda item: item["index"]):
        obj = copy.deepcopy(item["object"])
        room.objects.insert(min(item["index"], len(room.objects)), obj)
        room.index[str(obj["id"])] = obj
        room.seq = max(room.seq, int(obj.get("seq", 0) or 0))
        restored.append({"index": item["index"], "object": obj})
    return [], restored
```

Обработчик:

```python
async def _handle_undo(manager, room, user, message):
    if not await _check_workspace(manager, user, message):
        return
    for _ in range(50):
        entry = manager.pop_history(room, user.id, user.workspace_id)
        if entry is None:
            break
        removed: list[str] = []
        objects: list[dict] = []
        if entry.get("created"):
            result = _undo_created_apply(user, room, entry)
            if result is None:
                continue
            removed = result
        elif entry.get("deleted"):
            result = _undo_deleted_apply(user, room, entry)
            if result is None:
                continue
            removed, objects = result
        elif entry.get("fields"):
            if not _undo_fields_apply(user, room, entry):
                continue
        else:
            continue
        for object_id, patch in (entry.get("fields") or {}).items():
            obj = room.get_object(object_id)
            if obj is not None:
                objects.append({"index": None, "object": copy.deepcopy(obj)})
        manager.mark_dirty(room)
        await manager.broadcast(
            room,
            {
                "type": "objects_restored",
                "removedIds": removed,
                "objects": objects,
                "workspaceId": user.workspace_id,
            },
            workspace_id=user.workspace_id,
        )
        return
    await manager.send_to(user, _error("undo_empty", "Нечего отменять"))
```

Замечание для реализатора: для записи `created` и `fields` одновременно событие должно
содержать и восстановленные объекты из `entry["fields"]` (например, дети отменённого фрейма);
это делает цикл после применения.

- [ ] **Step 7: Диспетчер и очистка**

- `_handle_message`: ветка `elif isinstance(message, Undo): await _handle_undo(...)`.
- `_handle_workspace_switch`: после успешного переключения —
  `manager.clear_history(room, user.id)`.
- `_handle_clear`: после очистки — `manager.clear_history(room)`.
- `_handle_workspace_delete`: после удаления страницы —
  `manager.clear_history(room, workspace_id=message.workspaceId)`.
- `_handle_kick`: после кика — `manager.clear_history(room, message.clientId)`.
- `RoomManager.leave`: перед удалением пользователя из комнаты —
  `self.clear_history(room, user_id)` (найти `async def leave` и добавить в начале).

- [ ] **Step 8: `objects_restored` в Redis**

- Добавить `"objects_restored"` в `WORKSPACE_SCOPED_EVENTS`.
- В `_sync_redis_event`:

```python
elif kind == "objects_restored":
    removed = [str(object_id) for object_id in message.get("removedIds", [])]
    if removed:
        await self._redis.hdel(objects_key, *removed)
    for item in message.get("objects", []):
        obj = item.get("object") if isinstance(item, dict) else None
        if isinstance(obj, dict) and isinstance(obj.get("id"), str):
            await self._redis.hset(
                objects_key, str(obj["id"]), json.dumps(obj, ensure_ascii=False)
            )
    await self._redis.set(self._seq_key(room.id), room.seq)
```

- В применении удалённого события: удалить `removedIds`, затем для каждого объекта обновить
  существующий или вставить по `index` (с зажимом), обновить `room.seq`; выставить
  `changed = True`.

- [ ] **Step 9: Прогнать тесты и линтеры**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py -q -p no:warnings`
Expected: PASS (14 тестов: 4 из Task 2 + 10 новых).

Run: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
Expected: PASS.

Run: `ruff check .`, `black --check .` — чисто.

- [ ] **Step 10: Redis-тест `objects_restored`**

В `test_redis.py` добавить тест: manager A создаёт объект и broadcast `objects_restored` с
`removedIds: []` и обновлённым объектом (`index: null`, изменённый `x`); manager B видит новый
`x`; затем broadcast с `removedIds: ["id"]` — manager B теряет объект.

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_redis.py -q -p no:warnings`
Expected: PASS.

- [ ] **Step 11: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/api/ws.py backend/app/services/room_manager.py backend/tests/test_board_undo_lock.py backend/tests/test_redis.py
git commit -m "feat: undo personal board actions"
```

---

### Task 4: Клиент замка

**Files:**
- Modify: `frontend/index.html` (кнопка `#lock-btn`)
- Modify: `frontend/css/style.css` (стили кнопки и значка)
- Modify: `frontend/js/board.js` (значок, `setObjectLocked`, обновление при transform)
- Modify: `frontend/js/main.js` (предикаты, обработка `object_lock`, кнопка)
- Test: `e2e/tests/board-undo-lock.spec.js`

**Interfaces:**
- Consumes: событие `object_lock`, поле `locked`, `Board.editPredicate`/`deletePredicate`
- Produces:
  - `Board.setObjectLocked(objectId: string, locked: boolean) -> void`
  - `Board._applyLockBadge(entry) -> void`
  - `Board.isLockedFor(object) -> boolean` (в `main.js` — локальная функция `lockedFor`)
  - видимая стаффу кнопка `#lock-btn`, значок `.lock-badge`

- [ ] **Step 1: Написать падающие E2E-тесты**

Добавить в `e2e/tests/board-undo-lock.spec.js`:

```js
async function lockBadgeCount(page) {
  return page.evaluate(
    () => window.Konva.stages[0].getLayers()[1].find('.lock-badge').length,
  );
}

test('lock: a student cannot move a locked block, teacher can unlock', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Lock block', student: true });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  const student = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await drawWithTool(teacher, 'process', { x: 200, y: 200 }, { x: 320, y: 280 });
  await expect.poll(() => objectCount(student)).toBe(1);
  await teacher.click('[data-tool="select"]');
  await clickWorld(teacher, { x: 260, y: 240 });
  await teacher.click('#lock-btn');
  await expect.poll(() => lockBadgeCount(student)).toBe(1);

  const before = await teacher.evaluate(() => {
    const group = window.Konva.stages[0].getLayers()[1].getChildren((n) => n.id())[0];
    return { x: group.x(), y: group.y() };
  });
  const from = await worldToScreen(student, { x: 260, y: 240 });
  await student.mouse.move(from.x, from.y);
  await student.mouse.down();
  await student.mouse.move(from.x + 120, from.y + 80, { steps: 8 });
  await student.mouse.up();
  const after = await teacher.evaluate(() => {
    const group = window.Konva.stages[0].getLayers()[1].getChildren((n) => n.id())[0];
    return { x: group.x(), y: group.y() };
  });
  expect(after).toEqual(before);

  await teacher.click('#lock-btn');
  await expect.poll(() => lockBadgeCount(student)).toBe(0);
  await student.click('[data-tool="select"]');
  await clickWorld(student, { x: 260, y: 240 });
  await student.mouse.move(from.x, from.y);
  await student.mouse.down();
  await student.mouse.move(from.x + 120, from.y + 80, { steps: 8 });
  await student.mouse.up();
  await expect
    .poll(() =>
      teacher.evaluate(() => {
        const group = window.Konva.stages[0].getLayers()[1].getChildren((n) => n.id())[0];
        return Math.round(group.x());
      }),
    )
    .toBeGreaterThan(280);

  await context.close();
});
```

И второй сценарий — замок фрейма и ребёнка:

```js
test('lock: a locked frame holds its children', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Lock frame', student: true });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  const student = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await drawWithTool(teacher, 'frame', { x: 100, y: 100 }, { x: 600, y: 500 });
  await drawWithTool(teacher, 'rect', { x: 200, y: 200 }, { x: 300, y: 280 });
  await expect.poll(() => objectCount(student)).toBe(2);
  await teacher.click('[data-tool="select"]');
  await clickWorld(teacher, { x: 560, y: 470 });
  await teacher.click('#lock-btn');
  await expect.poll(() => lockBadgeCount(student)).toBe(1);

  const child = await student.evaluate(() => {
    const group = window.Konva.stages[0]
      .getLayers()[1]
      .getChildren((n) => n.id() && n.findOne('Rect'))
      .find((n) => !n.findOne('.frame-bg'));
    return { x: group.x(), y: group.y() };
  });
  const from = await worldToScreen(student, { x: 250, y: 240 });
  await student.mouse.move(from.x, from.y);
  await student.mouse.down();
  await student.mouse.move(from.x + 150, from.y + 100, { steps: 8 });
  await student.mouse.up();
  const after = await student.evaluate(() => {
    const group = window.Konva.stages[0]
      .getLayers()[1]
      .getChildren((n) => n.id() && n.findOne('Rect'))
      .find((n) => !n.findOne('.frame-bg'));
    return { x: group.x(), y: group.y() };
  });
  expect(after).toEqual(child);

  await context.close();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/board-undo-lock.spec.js`
Expected: FAIL — `#lock-btn` отсутствует, значков нет.

- [ ] **Step 3: Добавить кнопку и стили**

В `frontend/index.html` рядом с `#frame-panel`:

```html
<button id="lock-btn" class="btn btn--ghost" type="button" title="Заблокировать" hidden>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
  <span>Замок</span>
</button>
```

В `frontend/css/style.css` добавить `.btn.is-active` (подсветка через `var(--accent, #2563eb)`)
и при необходимости поправить `gap` тулбара. Значок рисуется в canvas, CSS ему не нужен.

- [ ] **Step 4: Значок и состояние в `Board`**

- Константа `LOCK_BADGE = '🔒'` и `LOCK_BADGE_SIZE = 14`.
- В `addObject` после создания узла и в `_applyTransform` вызывать `this._applyLockBadge(entry)`.
- Метод:

```js
_applyLockBadge(entry) {
  if (!entry.node.add) return; // штрих — Shape, значок на нём не рисуем
  let badge = entry.node.findOne('.lock-badge');
  if (!entry.data.locked) {
    badge?.destroy();
    entry.node.getLayer()?.batchDraw();
    return;
  }
  if (!badge) {
    badge = new Konva.Text({
      name: 'lock-badge',
      text: LOCK_BADGE,
      fontSize: LOCK_BADGE_SIZE,
      listening: false,
    });
    entry.node.add(badge);
  }
  const box = entry.node.getClientRect({ relativeTo: entry.node, skipShadow: true });
  badge.position({ x: box.x + box.width - LOCK_BADGE_SIZE, y: box.y + 2 });
  entry.node.getLayer()?.batchDraw();
}

setObjectLocked(objectId, locked) {
  const entry = this.objects.get(objectId);
  if (!entry) return;
  entry.data.locked = Boolean(locked);
  this._applyLockBadge(entry);
  this._applyDraggable(entry);
  if (entry.data.id === this.selectedId) this.selectObject(objectId);
  this.contentLayer.batchDraw();
}
```

Для штрихов `entry.node` — `Konva.Line` (без `add`), поэтому значок не создаётся; замок на
штрихе всё равно блокирует стирание на сервере и через `deletePredicate`.

- [ ] **Step 5: Предикаты и кнопка в `main.js`**

В `startRoom` добавить:

```js
const lockedFor = (object) => {
  if (!object || !state.user || isStaff(state.user.role)) return false;
  if (object.locked) return true;
  if (!object.frameId) return false;
  return Boolean(state.board?.getObjectData(object.frameId)?.locked);
};
```

`canEditObject`: `Boolean(state.user) && (isStaff(...) || (!lockedFor(object) && object.author === state.user.id))`.

`canDeleteObject`: для стаффа `true`; иначе `false`, если `lockedFor(object)` или автор чужой;
для фрейма дополнительно `false`, если любой ребёнок заблокирован.

Кэшировать `els.lockBtn = $('#lock-btn')`, в `bindToolbar`:

```js
els.lockBtn.addEventListener('click', () => {
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  if (!object || !isStaff(state.user?.role)) return;
  sendWorkspace({ type: 'object_lock', objectId: id, locked: !object.locked });
});
```

`onSelectObject` дополнить вызовом `updateLockButton()`; функция:

```js
function updateLockButton() {
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  const staff = isStaff(state.user?.role);
  els.lockBtn.hidden = !staff || !object;
  if (!object) return;
  els.lockBtn.classList.toggle('is-active', Boolean(object.locked));
  els.lockBtn.title = object.locked ? 'Снять блокировку' : 'Заблокировать';
}
```

- [ ] **Step 6: Обработка события**

В оба switch (`workspace`-список и `applyObjectEvent`) добавить `case 'object_lock':`;
в `applyObjectEvent`:

```js
case 'object_lock':
  board.setObjectLocked(message.objectId, message.locked);
  updateLockButton();
  break;
```

- [ ] **Step 7: Прогнать E2E и полный backend**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/board-undo-lock.spec.js`
Expected: PASS (3 теста: ластик + 2 замка).

Run: полный E2E `npx.cmd playwright test` — 31 passed (было 28 + 3).

- [ ] **Step 8: Коммит**

```bash
git add frontend/index.html frontend/css/style.css frontend/js/board.js frontend/js/main.js e2e/tests/board-undo-lock.spec.js
git commit -m "feat: lock objects in the board UI"
```

---

### Task 5: Клиент отмены

**Files:**
- Modify: `frontend/index.html` (кнопка `#undo-btn`)
- Modify: `frontend/js/board.js` (`applyObjectsRestored`)
- Modify: `frontend/js/main.js` (кнопка, Ctrl+Z, событие)
- Test: `e2e/tests/board-undo-lock.spec.js`

**Interfaces:**
- Consumes: событие `objects_restored`, `Board.removeObject`, `Board.addObject`, `Board.applyObjectTransform`, `setObjectLocked`
- Produces:
  - `Board.applyObjectsRestored({ removedIds, objects }) -> void`
  - `#undo-btn`, `requestUndo()`, горячая клавиша Ctrl+Z/Cmd+Z

- [ ] **Step 1: Написать падающие E2E-тесты**

Добавить в `e2e/tests/board-undo-lock.spec.js`:

```js
async function positionOfFirst(page) {
  return page.evaluate(() => {
    const group = window.Konva.stages[0].getLayers()[1].getChildren((n) => n.id())[0];
    return group ? { x: Math.round(group.x()), y: Math.round(group.y()) } : null;
  });
}

test('undo: removes a created shape and restores an erased stroke', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo', student: true });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  const student = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await drawRect(teacher, { x: 200, y: 200 }, { x: 300, y: 280 });
  await expect.poll(() => objectCount(student)).toBe(1);
  await teacher.click('#undo-btn');
  await expect.poll(() => objectCount(student)).toBe(0);

  await drawWithTool(student, 'brush', { x: 400, y: 300 }, { x: 600, y: 300 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await eraseAt(student, { x: 420, y: 300 }, { x: 580, y: 300 });
  await expect.poll(() => objectCount(student)).toBe(0);
  await student.click('#undo-btn');
  await expect.poll(() => objectCount(student)).toBe(1);

  await context.close();
});

test('undo: ctrl+z restores a moved object and empty history toasts', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo move', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 100, y: 100 }, { x: 220, y: 180 });
  await page.click('[data-tool="select"]');
  const before = await positionOfFirst(page);
  await dragBy(page, { x: 160, y: 140 }, 140, 80);
  await expect.poll(async () => (await positionOfFirst(page)).x).toBeGreaterThan(before.x + 100);

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await positionOfFirst(page)).x).toBe(before.x);

  await page.keyboard.press('Control+z'); // удаляет созданный прямоугольник
  await expect.poll(() => objectCount(page)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#toast')).toHaveText('Нечего отменять');

  await context.close();
});
```

`dragBy` уже экспортируется из `../helpers.js`; добавить его в импорт.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: spec.
Expected: FAIL — `#undo-btn` отсутствует.

- [ ] **Step 3: Кнопка и горячая клавиша**

В `index.html` рядом с `#image-btn`:

```html
<button id="undo-btn" class="btn btn--ghost" type="button" title="Отменить (Ctrl+Z)">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5" /><path d="M4 12h9a6 6 0 0 1 0 12h-2" /></svg>
  <span>Отменить</span>
</button>
```

В `main.js`:

```js
function requestUndo() {
  if (!state.board || state.tools?.isDrawing()) return;
  sendWorkspace({ type: 'undo' });
}
```

В `bindToolbar`: `els.undoBtn = $('#undo-btn'); els.undoBtn.addEventListener('click', requestUndo);`

В `bindKeyboard` в начале обработчика, до проверки Ctrl/Alt:

```js
const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
if (typing) return;
if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
  event.preventDefault();
  requestUndo();
  return;
}
```

Убрать дублирующую проверку `target` ниже, чтобы не было двух ранних return.

В `ToolManager` (`frontend/js/tools.js`) добавить:

```js
isDrawing() {
  return Boolean(this.stroke || this.shape || this.erasing);
}
```

- [ ] **Step 4: Применение `objects_restored` в `Board`**

```js
applyObjectsRestored({ removedIds = [], objects = [] }) {
  for (const id of removedIds) this.removeObject(id);
  for (const item of objects) {
    const object = item.object;
    if (!object) continue;
    if (this.objects.has(object.id)) {
      this.applyObjectTransform(object);
    } else {
      this.addObject(object);
    }
    this._applyLockBadge(this.objects.get(object.id));
  }
  this.contentLayer.batchDraw();
}
```

Убедиться, что `applyObjectTransform` обновляет `frameId`, подпись, фон и размер (уже делает),
и что `addObject` восстанавливает фреймы внизу (уже делает).

- [ ] **Step 5: Обработка события в `main.js`**

В оба switch добавить `case 'objects_restored':`; в `applyObjectEvent`:

```js
case 'objects_restored':
  board.applyObjectsRestored(message);
  updateLockButton();
  updateFramePanel();
  break;
```

- [ ] **Step 6: Прогнать тесты**

Run spec.
Expected: PASS (5 тестов в файле).

Run полный E2E: `npx.cmd playwright test`
Expected: 33 passed (28 + 5).

Run backend: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings` — PASS.

- [ ] **Step 7: Коммит**

```bash
git add frontend/index.html frontend/js/board.js frontend/js/main.js frontend/js/tools.js e2e/tests/board-undo-lock.spec.js
git commit -m "feat: undo personal actions from the toolbar"
```

---

### Task 6: Документация и регрессия

**Files:**
- Modify: `README.md`
- Modify: `plan.md`
- Test: полный прогон

**Interfaces:**
- Consumes: всё выше
- Produces: описание P7 в журнале и документации

- [ ] **Step 1: Обновить `plan.md`**

Добавить раздел `### P7. Ластик по кисти, отмена и блокировка ✅` с чекбоксами по трём
возможностям и фактическими числами тестов.

- [ ] **Step 2: Обновить `README.md`**

В разделе возможностей: ластик стирает только штрихи; отмена (Ctrl+Z, личная, включая
удаление); замок учителя (запрещает ученику любые изменения, наследуется детьми фрейма).

- [ ] **Step 3: Полный прогон**

- backend: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
- линтеры: `ruff check .`, `black --check .`
- E2E: `$env:PYTHON='...'; npx.cmd playwright test`
- `docker compose config --quiet` → exit 0

- [ ] **Step 4: Саморевью и коммит**

Проверить по спеке: все три пункта, Review Focus, отсутствие мёртвого кода. Затем:

```bash
git add README.md plan.md
git commit -m "docs: describe eraser, undo and locks"
```

---

## Self-Review

- **Покрытие спеки:** ластик (Task 1), замок сервер/клиент (Task 2/4), отмена сервер/клиент
  (Task 3/5), Redis-синхронизация (Task 2 Step 8, Task 3 Step 10), документация (Task 6).
- **Review Focus → тесты:** stale-поля (Task 3 `test_undo_move_keeps_other_fields`); замок и
  отмена (Task 3 `test_undo_skips_locked_object_for_student`); фрейм (Task 2
  `test_student_object_is_not_captured_by_locked_frame`, Task 4 frame-сценарий); каскады
  (Task 3 frame/block-тесты); пустой стек и смена страницы (Task 3 empty/switch, Task 5 toast).
- **Типы:** `objects_restored` — `{index, object}` в сервере и клиенте; `_capture_into_frame`
  возвращает `(ids, previous)` и в Task 2 Step 5, и в Task 3 Step 5; `clear_history` —
  `(room, user_id=None, workspace_id=None)`.
- **Пропорция:** шаги задают сигнатуры и проверки, тела — только там, где алгоритм неочевиден
  (undo-применение, инверсия по категориям).
