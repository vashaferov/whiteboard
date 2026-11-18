# Замок для всех, размер холста и «невидимка»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать замок обязательным для всех ролей, добавить настраиваемый размер холста на комнату и скрыть администратора от учеников с возможностью снять «невидимку».

**Architecture:** Замок перестаёт пропускать staff в единственной функции `_locked_for` и в клиентских предикатах. Размер комнаты хранится в `Room.board`, снимке и Redis, меняется staff сообщением `board_resize` и применяется у всех без сброса зума. Невидимость — поле `ConnectedUser.invisible`, отфильтрованный ростер `users_state` и скрытие курсора; state-сообщение заменяет инкрементальные `user_joined`/`user_left` для списка.

**Tech Stack:** FastAPI, Pydantic v2, pytest, ванильный JS, Konva.js, CSS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-lock-canvas-invisibility-design.md`

## Global Constraints

- Замок запрещает все изменения объекта и его детей любой роли, включая staff; staff всегда может снять замок и отменить само запирание.
- Размер холста — на комнату; целые 640–4000, отношение сторон 1:4–4:1; существующие объекты не масштабируются и не удаляются.
- Скрытый администратор не виден ученикам ни в списке, ни курсором; учителя и staff видят его всегда; состояние на подключение, по умолчанию скрыт.
- Новых зависимостей нет; старые снимки и Redis без новых полей читаются с значениями по умолчанию.
- Русские подписи и существующий стиль кода.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.
- Перед мержем — отдельный запрос разрешения пользователю.

## Review Focus

- Заблокированный объект нельзя переместить/изменить/удалить ни учителю, ни администратору; замок снимается кнопкой и отменой.
- Дети заблокированного фрейма тоже не меняются staff-ом.
- Смена размера не сбрасывает зум у других участников и сохраняется после перезагрузки и рестарта.
- Валидные границы размера: 639/4001 и перекос 1:5 отклоняются, крайние 640/4000 и 1:4 проходят.
- Скрытый администратор не утекает ученику ни в `init`, ни в `users_state`, ни через курсор; видимый появляется и исчезает по переключателю.
- После выхода администратора его запись исчезает у всех, а `userCount` совпадает с длиной списка.

---

## Структура файлов

- `backend/app/api/ws.py` — `_locked_for`, `BoardResize`, `set_invisible`, `_handle_board_resize`,
  `_handle_set_invisible`, `init` с `room.board`, ростер.
- `backend/app/models/schemas.py` — `BoardResize`, `SetInvisible`, union.
- `backend/app/services/room_manager.py` — `Room.board`, `normalize_board`, `list_users(viewer)`,
  `broadcast_users_state`, Redis board/presence, `users_changed`.
- `backend/app/services/storage.py` — колонка и поле `board` в снимке.
- `backend/tests/test_board_undo_lock.py` — замок для staff и отмена замка.
- `backend/tests/test_text_fonts.py` — обновить сценарий с замком.
- `backend/tests/test_board_size.py` — размер холста.
- `backend/tests/test_invisibility.py` — ростер и курсоры.
- `backend/tests/test_redis.py` — размер и presence на двух инстансах.
- `frontend/js/main.js` — предикаты замка, панель размера, `users_state`, глаз.
- `frontend/js/board.js` — `setBoardSize` без сброса зума.
- `frontend/index.html`, `frontend/css/style.css` — панель размера и кнопка-глаз.
- `e2e/tests/board-undo-lock.spec.js`, `board-size.spec.js`, `invisibility.spec.js`.
- `README.md`, `plan.md` — документация.

---

### Task 1: Замок для всех

**Files:**
- Modify: `backend/app/api/ws.py:118-126`, `:1229-1248`
- Modify: `frontend/js/main.js:267-275`, `:492-497`
- Test: `backend/tests/test_board_undo_lock.py`, `backend/tests/test_text_fonts.py`
- Test: `e2e/tests/board-undo-lock.spec.js`

**Interfaces:**
- Produces: `_locked_for(room, obj)` без учёта роли, `True` для самого объекта
  или заблокированного родительского фрейма.
- Produces: отмена записи `{"locked": false}` разрешена staff даже на заблокированном объекте.

- [ ] **Step 1: Написать падающие backend-тесты**

Добавить в `test_board_undo_lock.py`:

```python
def test_teacher_cannot_change_locked_object(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(shape("block"))
        barrier(tw)
        tw.send_json({"type": "object_lock", "objectId": "block", "locked": True})
        barrier(tw)

        for message in (
            {"type": "object_update", "objectId": "block", "x": 90, "y": 90},
            {
                "type": "object_transform",
                "objectId": "block",
                "x": 90,
                "y": 90,
                "rotation": 0,
                "width": 60,
                "height": 50,
            },
            {"type": "object_delete", "objectId": "block"},
        ):
            tw.send_json(message)
            assert "locked" in codes(barrier(tw))

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["objects"][0]["object"]["locked"] is False
        tw.send_json({"type": "object_update", "objectId": "block", "x": 90, "y": 90})
        assert "locked" not in codes(barrier(tw))
```

Добавить проверку ребёнка фрейма:

```python
def test_teacher_cannot_change_child_of_locked_frame(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(frame("frame-1"))
        barrier(tw)
        tw.send_json(shape("inner"))
        barrier(tw)
        tw.send_json({"type": "object_lock", "objectId": "frame-1", "locked": True})
        barrier(tw)
        tw.send_json({"type": "object_update", "objectId": "inner", "x": 70, "y": 70})
        assert "locked" in codes(barrier(tw))
```

В `test_text_fonts.py` заменить заключительную часть `test_font_change_permissions_and_broadcast`:
после блокировки проверить отказ staff, затем отменить замок и только потом менять шрифт.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py tests/test_text_fonts.py -q -p no:warnings`
Expected: FAIL — учитель получает `object_update`/`text_font` вместо `locked`.

- [ ] **Step 3: Убрать обход для staff на сервере**

```python
def _locked_for(room: Room, obj: dict[str, Any]) -> bool:
    """A locked object and the children of a locked frame reject all edits."""
    if obj.get("locked"):
        return True
    frame_id = obj.get("frameId")
    frame = room.get_object(str(frame_id)) if frame_id else None
    return bool(frame and frame.get("locked"))
```

Заменить все вызовы `_locked_for(user, room, x)` на `_locked_for(room, x)`.

В `_undo_fields_apply` разрешить staff восстанавливать только поле замка:

```python
        if _locked_for(room, obj) and not (
            is_staff(user.role) and set(patch) <= {"locked"}
        ):
            return False
```

- [ ] **Step 4: Убрать обход на клиенте**

`frontend/js/main.js`:

```js
function lockedFor(object) {
  if (!object) return false;
  if (object.locked) return true;
  if (!object.frameId) return false;
  return Boolean(state.board?.getObjectData(object.frameId)?.locked);
}
```

```js
    canEditObject: (object) =>
      Boolean(state.user) &&
      !lockedFor(object) &&
      (isStaff(state.user.role) || object.author === state.user.id),
    canDeleteObject: (object) => {
      if (!state.user || lockedFor(object)) return false;
      if (isStaff(state.user.role)) return true;
      ...
```

- [ ] **Step 5: Обновить E2E блокировки**

В `board-undo-lock.spec.js` после проверки ученика добавить попытку учителя:

```js
    const beforeTeacher = await objectPosition(teacher);
    await teacher.click('[data-tool="select"]');
    const teacherStart = await worldToScreen(teacher, { x: 260, y: 240 });
    await dragBy(teacher, teacherStart, 120, 80);
    await expect.poll(async () => (await objectPosition(teacher)).x).toBe(beforeTeacher.x);
```

Оставить существующее снятие замка через `#undo-btn`: оно должно работать
благодаря правке `_undo_fields_apply`.

- [ ] **Step 6: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_undo_lock.py tests/test_text_fonts.py -q -p no:warnings`
Run: `npx.cmd playwright test tests/board-undo-lock.spec.js --timeout=30000`
Expected: все passed.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/api/ws.py backend/tests/test_board_undo_lock.py backend/tests/test_text_fonts.py frontend/js/main.js e2e/tests/board-undo-lock.spec.js
git commit -m "feat: apply locks to every role"
```

---

### Task 2: Размер холста на сервере

**Files:**
- Modify: `backend/app/models/schemas.py` (новый `BoardResize`, union)
- Modify: `backend/app/services/room_manager.py` (`Room.board`, `normalize_board`, снимок, Redis)
- Modify: `backend/app/services/storage.py` (колонка `board`)
- Modify: `backend/app/api/ws.py` (init, `_handle_board_resize`)
- Test: `backend/tests/test_board_size.py`, `backend/tests/test_storage.py`, `backend/tests/test_redis.py`

**Interfaces:**
- Produces: `BOARD_MIN = 640`, `BOARD_MAX = 4000`, `BOARD_RATIO = 4`.
- Produces: `normalize_board(board: dict | None, fallback: dict[str, int]) -> dict[str, int]`.
- Produces: `Room.board: dict[str, int]`; `Snapshot.board: dict[str, int]`.
- Produces: `RoomManager.set_board(room, width, height) -> bool`.
- Produces: клиент→сервер `board_resize {width, height}`; сервер→клиент
  `board_resize {width, height}`; `init.board` из комнаты.

- [ ] **Step 1: Написать падающие backend-тесты**

Создать `backend/tests/test_board_size.py`:

```python
"""Размер холста комнаты."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def test_board_size_defaults_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        init = tw.receive_json()
        assert init["board"] == {"width": 1600, "height": 900}
        sw.receive_json()
        barrier(tw)

        tw.send_json({"type": "board_resize", "width": 1200, "height": 800})
        assert recv_until(sw, "board_resize") == {
            "type": "board_resize",
            "width": 1200,
            "height": 800,
        }

        sw.send_json({"type": "board_resize", "width": 900, "height": 700})
        assert codes(barrier(sw)) == ["forbidden"]


def test_board_size_bounds(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        for width, height in ((639, 900), (1600, 4001), (4000, 500), (2000, 400)):
            tw.send_json({"type": "board_resize", "width": width, "height": height})
            assert recv_until(tw, "error")["code"] == "invalid_message"
        tw.send_json({"type": "board_resize", "width": 640, "height": 2560})
        assert recv_until(tw, "board_resize")["height"] == 2560
```

В `test_storage.py` добавить roundtrip поля:

```python
async def test_snapshot_roundtrip_preserves_board(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots.db")
    await store.save("room-1", [], 0, [], board={"width": 1200, "height": 800})
    snapshot = await store.load("room-1")
    assert snapshot is not None
    assert snapshot.board == {"width": 1200, "height": 800}
    await store.close()
```

В `test_redis.py` добавить проверку, что после `set_board` второй менеджер
получает размер при восстановлении комнаты (по образцу существующих тестов
`fakeredis`).

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_size.py -q -p no:warnings`
Expected: FAIL — неизвестное сообщение, нет поля `board` у снимка.

- [ ] **Step 3: Добавить схему**

```python
class BoardResize(_Message):
    type: Literal["board_resize"]
    width: int = Field(ge=640, le=4000)
    height: int = Field(ge=640, le=4000)
```

Добавить `| BoardResize` в `ClientMessage`.

- [ ] **Step 4: Хранить размер в комнате и снимке**

В `room_manager.py`:

```python
BOARD_MIN = 640
BOARD_MAX = 4000
BOARD_RATIO = 4


def normalize_board(board: dict[str, Any] | None, fallback: dict[str, int]) -> dict[str, int]:
    try:
        width = int(board["width"]) if board else fallback["width"]
        height = int(board["height"]) if board else fallback["height"]
    except (KeyError, TypeError, ValueError):
        return dict(fallback)
    if not (BOARD_MIN <= width <= BOARD_MAX and BOARD_MIN <= height <= BOARD_MAX):
        return dict(fallback)
    if max(width / height, height / width) > BOARD_RATIO:
        return dict(fallback)
    return {"width": width, "height": height}
```

`Room.__init__` получает `board=None` и `self.board = dict(board or {"width": 1600, "height": 900})`.
`RoomManager.get_or_create` после загрузки снимка/Redis выставляет
`normalize_board(..., fallback={"width": settings.board_width, "height": settings.board_height})`.

В `storage.py` добавить колонку и миграцию:

```sql
board TEXT NOT NULL DEFAULT '{}'
```

```python
if "board" not in columns:
    conn.execute("ALTER TABLE room_snapshots ADD COLUMN board TEXT NOT NULL DEFAULT '{}'")
```

`Snapshot.board: dict[str, int]`; `save(..., board=None)` пишет JSON,
`load` разбирает с `.get("board") or {}`.

- [ ] **Step 5: Redis и метод изменения**

Добавить `_board_key`, включить в `_delete_room_keys`, `_seed_redis_state`,
`_restore_redis_state`, `_sync_redis_event` (тип `board_resize`) и
`_apply_remote_event` (`room.board = {"width": ..., "height": ...}`).

```python
    def set_board(self, room: Room, width: int, height: int) -> bool:
        board = {"width": int(width), "height": int(height)}
        if board == room.board:
            return False
        room.board = board
        self.mark_dirty(room)
        return True
```

Валидацию диапазона и пропорций делает обработчик.

- [ ] **Step 6: Обработчик и init**

В `init` заменить `"board": {...settings...}` на `"board": dict(room.board)`.

```python
async def _handle_board_resize(manager, room, user, message) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Менять размер может только учитель"))
        return
    if max(message.width / message.height, message.height / message.width) > BOARD_RATIO:
        await manager.send_to(user, _error("invalid_message", "Слишком вытянутый холст"))
        return
    if not manager.set_board(room, message.width, message.height):
        return
    await manager.broadcast(
        room,
        {"type": "board_resize", "width": message.width, "height": message.height},
    )
```

Добавить ветку диспетчера и импорт `BoardResize`.

- [ ] **Step 7: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_size.py tests/test_storage.py tests/test_redis.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 8: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/services/room_manager.py backend/app/services/storage.py backend/app/api/ws.py backend/tests/test_board_size.py backend/tests/test_storage.py backend/tests/test_redis.py
git commit -m "feat: store a per-room board size"
```

---

### Task 3: Интерфейс размера холста и E2E

**Files:**
- Modify: `frontend/js/board.js` (`setBoardSize`)
- Modify: `frontend/js/main.js` (панель, обработка `board_resize`)
- Modify: `frontend/index.html`, `frontend/css/style.css`
- Test: `e2e/tests/board-size.spec.js`

**Interfaces:**
- Consumes: `init.board`, `board_resize` (Task 2).
- Produces: DOM `#board-size-btn`, `#board-size-panel`, `#board-width`, `#board-height`,
  `#board-size-apply`; `Board.setBoardSize(w, h)` сохраняет зум.

- [ ] **Step 1: Написать падающий E2E**

Создать `e2e/tests/board-size.spec.js`:

```js
import { expect, test } from '@playwright/test';

import { lessonSetup, openRoom, reloadAndWait, signInWith } from '../helpers.js';

function boardSize(page) {
  return page.evaluate(() => {
    const paper = window.Konva.stages[0].getLayers()[0].getChildren()[0];
    return { width: paper.width(), height: paper.height() };
  });
}

test('board size changes for everyone and survives reload', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Board size' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await teacher.click('#board-size-btn');
  await teacher.fill('#board-width', '1200');
  await teacher.fill('#board-height', '800');
  await teacher.click('#board-size-apply');
  await expect.poll(() => boardSize(student)).toEqual({ width: 1200, height: 800 });

  await reloadAndWait(teacher);
  expect(await boardSize(teacher)).toEqual({ width: 1200, height: 800 });

  await teacherContext.close();
  await studentContext.close();
});
```

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/board-size.spec.js --timeout=30000`
Expected: FAIL — нет `#board-size-btn`.

- [ ] **Step 3: Сохранять зум при смене размера**

В `board.js`:

```js
  setBoardSize(width, height) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.paper.size({ width, height });
    this.grid.size({ width, height });
    this.layout();
  }
```

- [ ] **Step 4: Добавить панель и обработку**

В `frontend/index.html` после `#frame-panel`:

```html
        <button id="board-size-btn" class="btn btn--ghost" type="button" hidden>Холст</button>
        <div id="board-size-panel" class="board-size-panel" hidden>
          <label>Ширина <input id="board-width" type="number" min="640" max="4000" step="10" /></label>
          <label>Высота <input id="board-height" type="number" min="640" max="4000" step="10" /></label>
          <button id="board-size-apply" class="btn btn--small btn--primary" type="button">Применить</button>
          <button id="board-size-preset" class="btn btn--small" type="button" data-preset="1600x900">16:9</button>
          <button id="board-size-preset-4-3" class="btn btn--small" type="button" data-preset="1440x1080">4:3</button>
          <button id="board-size-preset-a4" class="btn btn--small" type="button" data-preset="1587x1123">A4</button>
          <button id="board-size-preset-square" class="btn btn--small" type="button" data-preset="1200x1200">1:1</button>
        </div>
```

В `main.js`:

```js
function bindBoardSize() {
  els.boardSizeBtn?.addEventListener('click', () => {
    els.boardSizePanel.hidden = !els.boardSizePanel.hidden;
    if (!els.boardSizePanel.hidden) {
      els.boardWidth.value = String(state.board.width);
      els.boardHeight.value = String(state.board.height);
    }
  });
  for (const preset of document.querySelectorAll('[data-preset]')) {
    preset.addEventListener('click', () => {
      const [width, height] = preset.dataset.preset.split('x');
      els.boardWidth.value = width;
      els.boardHeight.value = height;
    });
  }
  els.boardSizeApply?.addEventListener('click', () => {
    const width = Number(els.boardWidth.value);
    const height = Number(els.boardHeight.value);
    if (!Number.isInteger(width) || !Number.isInteger(height)) return;
    sendWorkspace({ type: 'board_resize', width, height });
    els.boardSizePanel.hidden = true;
  });
}
```

Кэш элементов, вызов `bindBoardSize()` в `init()`, видимость кнопки:
`els.boardSizeBtn.hidden = isPresentation() || !isStaff(state.user?.role);`
в `updateToolbar()` и `applyWorkspaceMode()`.

Обработка события:

```js
    case 'board_resize':
      board.setBoardSize(message.width, message.height);
      updateBoardSizePanel();
      break;
```

`updateBoardSizePanel()` обновляет поля, если панель открыта.

- [ ] **Step 5: Стили**

Добавить `.board-size-panel` в стиле `frame-panel` (flex, отступы, границы, скрытие по `[hidden]`).

- [ ] **Step 6: Прогнать E2E**

Run: `npx.cmd playwright test tests/board-size.spec.js tests/zoom.spec.js --timeout=30000`
Expected: все passed, зум в `zoom.spec.js` не сломан.

- [ ] **Step 7: Коммит**

```bash
git add frontend/js/board.js frontend/js/main.js frontend/index.html frontend/css/style.css e2e/tests/board-size.spec.js
git commit -m "feat: resize the board from the toolbar"
```

---

### Task 4: Невидимость на сервере

**Files:**
- Modify: `backend/app/models/schemas.py` (`SetInvisible`, union)
- Modify: `backend/app/services/room_manager.py` (`ConnectedUser.invisible`, `list_users`, presence, ростер)
- Modify: `backend/app/api/ws.py` (init, вход, выход, курсор, обработчик)
- Test: `backend/tests/test_invisibility.py`, `backend/tests/test_redis.py`
- Test: обновить тесты, ожидающие `user_joined`/`user_left`

**Interfaces:**
- Produces: `ConnectedUser.invisible: bool`, у admin при подключении `True`.
- Produces: `list_users(room, viewer=None)`; `broadcast_users_state(room)`;
  `publish_users_changed(room)`; `set_invisible(room, user, invisible) -> bool`.
- Produces: сообщение клиенту `users_state {users, userCount, invisible}`;
  клиент→сервер `set_invisible {invisible}` (только admin); Redis-событие `users_changed`.

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/tests/test_invisibility.py`:

```python
"""Невидимость администратора."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def next_roster(websocket) -> dict:
    while True:
        message = websocket.receive_json()
        if message["type"] == "users_state":
            return message


def last_roster(messages: list[dict]) -> dict:
    return [message for message in messages if message["type"] == "users_state"][-1]


def test_hidden_admin_is_absent_for_student(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    admin = login_user("Администратор", "admin")

    with (
        ws_connect(client, teacher["token"]) as tw,
        ws_connect(client, student["token"]) as sw,
        ws_connect(client, admin["token"]) as aw,
    ):
        tw.receive_json()
        student_init = sw.receive_json()
        admin_init = aw.receive_json()

        assert admin["user"]["id"] not in [user["id"] for user in student_init["users"]]
        assert admin_init["invisible"] is True

        teacher_roster = last_roster(barrier(tw))
        student_roster = last_roster(barrier(sw))
        assert admin["user"]["id"] in [user["id"] for user in teacher_roster["users"]]
        assert admin["user"]["id"] not in [user["id"] for user in student_roster["users"]]

        aw.send_json({"type": "set_invisible", "invisible": False})
        visible = next_roster(sw)
        assert admin["user"]["id"] in [user["id"] for user in visible["users"]]

        aw.send_json({"type": "set_invisible", "invisible": True})
        hidden = next_roster(sw)
        assert admin["user"]["id"] not in [user["id"] for user in hidden["users"]]


def test_only_admin_can_toggle_visibility(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json({"type": "set_invisible", "invisible": False})
        assert codes(barrier(tw)) == ["forbidden"]


def test_hidden_admin_cursor_is_private(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    admin = login_user("Администратор", "admin")
    with (
        ws_connect(client, teacher["token"]) as tw,
        ws_connect(client, student["token"]) as sw,
        ws_connect(client, admin["token"]) as aw,
    ):
        tw.receive_json()
        sw.receive_json()
        aw.receive_json()
        barrier(tw)
        barrier(sw)

        aw.send_json({"type": "cursor", "workspaceId": "ws_default", "x": 10, "y": 20})
        assert [m for m in barrier(sw) if m["type"] == "cursor"] == []

        aw.send_json({"type": "set_invisible", "invisible": False})
        next_roster(sw)
        aw.send_json({"type": "cursor", "workspaceId": "ws_default", "x": 30, "y": 40})
        assert recv_until(sw, "cursor")["id"] == admin["user"]["id"]
```

Обновить существующие тесты, которые ждут `user_joined`/`user_left`
(`test_ws.py`, `test_workspaces_ws.py`, `test_redis.py`, `test_rooms*`):
заменить ожидание на `users_state` и проверять id в списке.

Для `test_redis.py`: второй менеджер с общим `fakeredis`, скрытый admin в presence
не появляется в `list_users(room, viewer=student)`, но виден `viewer=teacher`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_invisibility.py -q -p no:warnings`
Expected: FAIL — нет `users_state`, админ виден ученику.

- [ ] **Step 3: Добавить поле и фильтрацию**

```python
@dataclass(slots=True)
class ConnectedUser:
    ...
    invisible: bool = False
```

В `ws._authenticate`: `invisible=account.role == "admin"`.

```python
STAFF_ROLES = {"teacher", "admin"}


async def list_users(self, room: Room, viewer: ConnectedUser | None = None) -> list[dict]:
    viewer_staff = viewer is None or viewer.role in STAFF_ROLES
    users: dict[str, dict] = {}
    for user in room.users.values():
        if user.invisible and not viewer_staff:
            continue
        entry = user.public()
        if viewer_staff:
            entry["invisible"] = user.invisible
        users[user.id] = entry
    # Redis presence: пропускать payload["hidden"] для не-staff,
    # добавлять entry["invisible"] для staff.
    return list(users.values())
```

`_presence_payload` добавляет `"hidden": user.invisible`.

- [ ] **Step 4: Ростер и события**

```python
    async def broadcast_users_state(self, room: Room) -> None:
        for user in list(room.users.values()):
            users = await self.list_users(room, viewer=user)
            await self.send_to(
                user,
                {
                    "type": "users_state",
                    "users": users,
                    "userCount": len(users),
                    "invisible": user.invisible,
                },
            )

    async def publish_users_changed(self, room: Room) -> None:
        if self._redis is not None:
            with suppress(Exception):
                await self._publish(room.id, {"event": {"type": "users_changed"}})
```

- В `websocket_endpoint` после `init` и вместо `user_joined` вызвать
  `await manager.broadcast_users_state(room)` и `await manager.publish_users_changed(room)`.
- В `_remove_users` вместо рассылки `user_left` вызвать `broadcast_users_state` и
  `publish_users_changed`.
- В `_listen` обработать `users_changed` до `_apply_remote_event`:
  `await self.broadcast_users_state(room); continue`.
- `init` использует `await manager.list_users(room, viewer=user)` и добавляет
  `"invisible": user.invisible`.

- [ ] **Step 5: Переключатель и курсор**

Метод менеджера (Redis и presence остаются внутри сервиса):

```python
    async def set_invisible(
        self, room: Room, user: ConnectedUser, invisible: bool
    ) -> bool:
        if user.invisible == invisible:
            return False
        user.invisible = invisible
        if self._redis is not None:
            with suppress(Exception):
                await self._set_presence(room.id, user)
        if invisible:
            await self.broadcast(room, {"type": "cursor_remove", "id": user.id})
        await self.broadcast_users_state(room)
        await self.publish_users_changed(room)
        return True
```

WS-обработчик:

```python
async def _handle_set_invisible(manager, room, user, message) -> None:
    if user.role != "admin":
        await manager.send_to(user, _error("forbidden", "Невидимость доступна администратору"))
        return
    await manager.set_invisible(room, user, message.invisible)
```

В `_handle_cursor` в начале после проверки workspace:

```python
    if user.invisible:
        return
```

Схема:

```python
class SetInvisible(_Message):
    type: Literal["set_invisible"]
    invisible: bool
```

- [ ] **Step 6: Прогнать backend-тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_invisibility.py tests/test_ws.py tests/test_workspaces_ws.py tests/test_redis.py -q -p no:warnings`
Expected: все passed.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/services/room_manager.py backend/app/api/ws.py backend/tests
git commit -m "feat: hide invisible admins from students"
```

---

### Task 5: Интерфейс «невидимки» и E2E

**Files:**
- Modify: `frontend/index.html` (кнопка-глаз)
- Modify: `frontend/js/main.js` (`users_state`, `state.invisible`, кнопка)
- Modify: `frontend/css/style.css`
- Test: `e2e/tests/invisibility.spec.js`

**Interfaces:**
- Consumes: `init.invisible`, `users_state`, `set_invisible` (Task 4).
- Produces: DOM `#invisible-toggle`; `state.invisible: boolean`.

- [ ] **Step 1: Написать падающий E2E**

Создать `e2e/tests/invisibility.spec.js`:

```js
import { expect, test } from '@playwright/test';

import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  lessonSetup,
  openLesson,
  openRoom,
  signInWith,
} from '../helpers.js';

test('admin is hidden from students until the eye is toggled', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Invisible admin' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signInWith(request, admin, ADMIN_LOGIN, ADMIN_PASSWORD);
  await openRoom(admin, setup.room.id);

  const adminRow = (page) => page.locator('#user-list .user[data-role="admin"]');
  await expect(adminRow(teacher)).toBeVisible();
  await expect(adminRow(student)).toBeHidden();

  await admin.click('#invisible-toggle');
  await expect(adminRow(student)).toBeVisible();

  await admin.click('#invisible-toggle');
  await expect(adminRow(student)).toBeHidden();
  await expect(adminRow(teacher)).toBeVisible();

  await adminContext.close();
  await teacherContext.close();
  await studentContext.close();
});
```

В `renderUsers` добавить `item.dataset.role = user.role;` — по нему тест находит строку.

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/invisibility.spec.js --timeout=30000`
Expected: FAIL — нет `#invisible-toggle`, админ виден ученику.

- [ ] **Step 3: Кнопка-глаз**

В заголовок панели участников рядом с `#users-toggle`:

```html
<button id="invisible-toggle" class="panel-toggle" type="button" hidden
  aria-pressed="true" aria-label="Показать меня ученикам" title="Показать меня ученикам">👁</button>
```

Кэш: `els.invisibleToggle`, `state.invisible = false`.

```js
function updateInvisibilityToggle() {
  if (!els.invisibleToggle) return;
  const admin = state.user?.role === 'admin';
  els.invisibleToggle.hidden = !admin;
  if (!admin) return;
  const hidden = Boolean(state.invisible);
  els.invisibleToggle.setAttribute('aria-pressed', String(hidden));
  const label = hidden ? 'Показать меня ученикам' : 'Скрыть меня от учеников';
  els.invisibleToggle.title = label;
  els.invisibleToggle.setAttribute('aria-label', label);
}
```

Клик:

```js
  els.invisibleToggle.addEventListener('click', () => {
    state.invisible = !state.invisible;
    updateInvisibilityToggle();
    sendWorkspace({ type: 'set_invisible', invisible: state.invisible });
  });
```

- [ ] **Step 4: Ростер**

```js
    case 'users_state': {
      state.users = new Map(message.users.map((user) => [user.id, user]));
      if (typeof message.invisible === 'boolean') state.invisible = message.invisible;
      for (const id of [...(state.board?.cursors.keys() ?? [])]) {
        if (!state.users.has(id)) state.board.removeCursor(id);
      }
      renderUsers();
      updateInvisibilityToggle();
      break;
    }
```

В `handleInit`: `state.invisible = Boolean(message.invisible);` и вызвать
`updateInvisibilityToggle()`.

Видимость кнопки: `updateInvisibilityToggle()` из `updateToolbar()`.

Пометка в списке для staff: в `renderUsers` для `user.invisible` добавить
`<span class="user__badge">невидимка</span>` (стиль — мелкий серый текст).

- [ ] **Step 5: Прогнать E2E**

Run: `npx.cmd playwright test tests/invisibility.spec.js --timeout=30000`
Expected: `1 passed`.

- [ ] **Step 6: Коммит**

```bash
git add frontend/index.html frontend/js/main.js frontend/css/style.css e2e/tests/invisibility.spec.js
git commit -m "feat: add the admin invisibility toggle"
```

---

### Task 6: Документация и полная регрессия

**Files:**
- Modify: `README.md`, `plan.md`

- [ ] **Step 1: README**

- Замок: «запирает элемент от любых изменений, включая правки учителя и администратора;
  снять замок может только staff, после снятия правки и отмена снова доступны».
- Размер холста: «staff задаёт размер комнаты от 640×640 до 4000×4000 с пресетами;
  размер общий для всех страниц, сохраняется и применяется у всех без сброса зума».
- Невидимка: «администратор по умолчанию скрыт от учеников; учителя его видят;
  кнопка-глаз показывает его ученикам и снова скрывает; курсор скрыт вместе с ним».

- [ ] **Step 2: plan.md**

- Раздел `### P13. Замок для всех, размер холста и невидимка ✅`.
- Пункт 15 в критериях готовности.
- Строка в журнале реализации.
- Блок проверки с фактическими числами тестов.
- Обновить команду локального прогона.

- [ ] **Step 3: Полная регрессия**

- `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- `backend`: `ruff check .`, `black --check .`.
- `e2e`: `npx.cmd playwright test`.
- `docker compose config --quiet`.

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: locks, board size and invisible admins"
```

- [ ] **Step 5: Спросить разрешение на merge**

Остановиться и спросить пользователя, можно ли мержить в `main` и деплоить.

---

## Self-Review

- **Спека:** замок (Task 1), размер комнаты (Task 2–3), невидимость (Task 4–5),
  документация (Task 6).
- **Review Focus → тесты:** staff-замок и дети фрейма (Task 1 backend+E2E), границы
  размера (Task 2), сохранение размера и зум (Task 2–3), утечка скрытого админа в
  init/ростере/курсоре (Task 4–5), выход и `userCount` (Task 4).
- **Типы:** `Room.board`/`Snapshot.board`/`board_resize`/`setBoardSize` согласованы;
  `invisible` одинаков в `ConnectedUser`, presence, `users_state`, `init` и UI.
- **Пропорция:** тела приведены для функций с неочевидным поведением (фильтрация
  ростера, границы, отмена замка); остальное задано сигнатурами и тестами.
