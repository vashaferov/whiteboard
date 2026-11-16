# Элементы доски: картинки, ластик, блок-схемы и фреймы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать ученикам сразу двигать свои картинки, заменить пиксельный ластик удалением
объектов, добавить блок-схемы с привязанными стрелками и фреймы с фоном и прикреплёнными
элементами.

**Architecture:** Плоская модель объектов комнаты расширяется новыми `shapeType` (блоки),
типом `connector` (стрелка, координаты выводятся из блоков) и типом `frame` (подложка,
дети хранят `frameId`). Сервер считает привязку к фрейму и каскады удаления; клиент зеркалит
привязку для мгновенного отклика и пересчитывает геометрию стрелок.

**Tech Stack:** FastAPI, Pydantic, SQLite/Redis, Konva.js, ванильный JS, pytest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-board-elements-design.md`

## Global Constraints

- Объекты комнаты — плоский список с `workspaceId`; все новые события фильтруются по странице.
- Новые WS-сообщения валидируются Pydantic с `extra="forbid"`; неизвестные поля запрещены.
- Старые снимки читаются без миграции: отсутствие `frameId`/`content` — нормальные значения.
- Старые пиксельные штрихи ластика (`tool: "eraser"`, `destination-out`) остаются объектами
  и рендерятся как раньше; новый ластик штрихов не создаёт.
- Права: стафф (учитель/админ) — любые объекты; ученик — только свои. Фрейм ученик удаляет,
  только если все его дети его. Клавиша Delete в UI остаётся стаффовой; ученик удаляет ластиком.
- Блоки: `process`, `decision`, `terminator`; подпись — `content` (1…2000), шрифт 16 px,
  поворот 0. Коннектор — только между двумя блоками на одной странице.
- Фрейм: `fill` (цвет или `null`), `pattern` ∈ `none|lines|grid`, `stroke`, `strokeWidth`;
  вложенности нет, обрезки нет, дети не масштабируются с фреймом.
- Тестовые команды: backend из `backend` — `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`,
  `ruff check .`, `black --check .`; E2E из `e2e` —
  `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.

## Review Focus

1. Удаление блока/фрейма не оставляет висячих стрелок и детей — у всех клиентов, после
   перезагрузки и на другом инстансе Redis. Тесты — Task 4/5/7.
2. Перемещение фрейма с детьми не даёт дрейфа при повторном/медленном событии; дети двигаются
   ровно на дельту фрейма, включая инициатора. Тесты — Task 5/6.
3. Ластик по ребёнку внутри фрейма не удаляет фрейм; ученик не может стереть чужое (и сервер
   это подтверждает). Тесты — Task 2/7.
4. Коннекторы корректно переживают перемещение, изменение размера и удаление блоков; свободные
   стрелки не меняют поведение. Тесты — Task 4.
5. Локальное авторство/привязка совпадает с серверным состоянием: новая картинка ученика
   двигается сразу, `frameId` не расходится после reload. Тесты — Task 1/6.

---

### Task 1: Авторство локальных объектов и сразу двигаемая картинка

**Files:**
- Modify: `frontend/js/tools.js`, `frontend/js/main.js`
- Test: `e2e/tests/board-elements.spec.js` (новый файл, первый тест)

**Interfaces:**
- Produces: `ToolManager({ board, onEvent, onCreateText, getAuthor, ... })` — `getAuthor()`
  возвращает id пользователя; локальные `stroke`/`shape` содержат `author`.
- Produces: после вставки картинки `selectTool('select')` и `state.board.selectObject(id)`.

- [ ] **Step 1: Написать падающий E2E**

`board-elements.spec.js`:

```js
test('images: a student moves a freshly uploaded image', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Images' });
  const { studentContext, student } = await openLesson(request, browser, setup);
  await student.setInputFiles('#file-input', { name: 'pixel.png',
    mimeType: 'image/png', buffer: PNG_1X1 });
  await expect.poll(() => student.evaluate(() =>
    window.Konva.stages[0].getLayers()[1]
      .getChildren((n) => n.getClassName() === 'Group' && n.findOne('Image')).length,
  )).toBe(1);
  await student.click('[data-tool="select"]');
  const before = await student.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const group = layer.getChildren((n) => n.findOne('Image')).at(-1);
    return { x: group.x(), y: group.y(), draggable: group.draggable() };
  });
  expect(before.draggable).toBe(true);
  // drag by the image center; position changes
  ...
  await reloadAndWait(student);
  // position persisted
});
```

Использовать `PNG_1X1` из helpers/теста; перетаскивание — `mouse.move/down/move/up` по
центру картинки (мировые координаты → экран через `boardBox`/stage).

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx.cmd playwright test tests/board-elements.spec.js -g "freshly uploaded image" --reporter=line`
Expected: FAIL — `draggable` равно `false` у ученика.

- [ ] **Step 3: Реализовать**

`tools.js`: конструктор принимает `getAuthor`; в `_startStroke` и `_finishShape` добавить
`author: this.getAuthor?.() ?? null` в локальный объект (не в сетевое сообщение).
`main.js`: передать `getAuthor: () => state.user?.id`; в локальные объекты `text`/`image`
добавить `author`; после `state.board.addObject(image)` выбрать инструмент `select` и
`state.board.selectObject(objectId)`.

- [ ] **Step 4: Прогнать тест и существующий E2E**

Run: `npx.cmd playwright test tests/board-elements.spec.js tests/lesson.spec.js tests/permissions.spec.js --reporter=line`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend e2e/tests/board-elements.spec.js
git commit -m "fix: let students move their own new objects"
```

---

### Task 2: Ластик удаляет объекты целиком

**Files:**
- Modify: `backend/app/api/ws.py` (`_handle_object_delete`), `backend/tests/test_ws.py`
  или новый `backend/tests/test_board_elements.py`
- Modify: `frontend/js/board.js`, `frontend/js/tools.js`, `frontend/js/main.js`
- Test: `backend/tests/test_board_elements.py`, `e2e/tests/board-elements.spec.js`

**Interfaces:**
- Produces (backend): `_can_delete_object(user, obj, room) -> bool` — стафф или автор;
  `object_delete` разрешён автору; чужие по-прежнему `forbidden`.
- Produces (frontend): `Board.eraseAt(point, radius) -> string[]` — локально удаляет и
  возвращает id; `Board` option `canDeleteObject(data) -> bool`;
  `ToolManager({ onErase(ids), ... })`; радиус `max(10, width * 1.5)` мировых единиц.
- Produces: `Board.objectIdAt(point) -> string | null` (пригодится Task 4).

- [ ] **Step 1: Написать падающие backend-тесты**

`test_board_elements.py`: два WS-клиента (учитель/ученик) в одной комнате.

```python
def test_student_deletes_own_object_but_not_teachers(client, login_user, ws_url):
    ...  # student shape_add; student object_delete -> уходит object_delete, объекта нет
    ...  # student object_delete чужого -> error forbidden, объект жив
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_board_elements.py -q -p no:warnings`
Expected: FAIL — `forbidden` для своего объекта / нет удаления.

- [ ] **Step 3: Реализовать сервер**

В `_handle_object_delete` заменить проверку роли на `_can_delete_object` (стафф или
`author == user.id`). Остальную логику (workspace, broadcast с `exclude=user.id`) сохранить.

- [ ] **Step 4: Написать падающий E2E ластика**

```js
test('eraser: deletes strokes, shapes, text and images; students only their own', ...)
```
Нарисовать кистью, прямоугольник, текст, вставить картинку; провести ластиком — все объекты
исчезают (`objectCount`/`getChildren`); у ученика ластик по объекту учителя ничего не удаляет;
учитель стирает объект ученика.

- [ ] **Step 5: Реализовать клиент**

`Board.eraseAt`: для штрихов — расстояние до сегментов; для групп/коннекторов/фреймов —
bbox (фрейм — полоса у рамки); фильтр `canDeleteObject`; удалить локально, вернуть id.
`ToolManager`: убрать `eraser` из `STROKE_TOOLS`; на down/move вызывать `board.eraseAt` и
`onErase(ids)`. `main.js`: `onErase` отправляет `object_delete` для каждого id; передать
`canDeleteObject` (стафф или автор).

- [ ] **Step 6: Прогнать backend и E2E**

Run backend: полный `pytest` — PASS. Run E2E: `board-elements.spec.js` — PASS.

- [ ] **Step 7: Commit**

```bash
git add backend frontend e2e/tests/board-elements.spec.js
git commit -m "feat: erase whole objects with the eraser"
```

---

### Task 3: Блоки схемы и подписи

**Files:**
- Modify: `backend/app/models/schemas.py` (`ShapeAdd.shapeType`)
- Modify: `backend/app/api/ws.py` (`_handle_shape_add`, `_handle_text_update`, transform rotation)
- Modify: `frontend/js/board.js`, `frontend/js/tools.js`, `frontend/js/main.js`,
  `frontend/index.html`, `frontend/css/style.css`
- Test: `backend/tests/test_board_elements.py`, `e2e/tests/board-elements.spec.js`

**Interfaces:**
- `FLOW_SHAPES = {"process", "decision", "terminator"}` (backend и JS).
- `ShapeAdd.shapeType` расширяется тремя значениями.
- `text_update` принимает `type == "text"` или `shape` с `shapeType` из `FLOW_SHAPES`;
  обновляет `content`; broadcast `text_update` с полным объектом.
- `object_transform` для блока/фрейма сохраняет `rotation = 0` (серверная нормализация).
- Фронт: `_createShapeNode` рисует процесс (Rect), решение (ромб), начало/конец
  (скруглённый Rect) и подпись `content` по центру; `SHAPE_TOOLS` включает три инструмента;
  `data-tool="process|decision|terminator"`, горячие клавиши `P`, `D`, `S`.
- Двойной клик по блоку открывает `#text-editor` с `content`; сохранение — `text_update`.

- [ ] **Step 1: Падающие backend-тесты**

```python
def test_flow_block_accepts_label(client, login_user, ws_url):
    ...  # shape_add process -> broadcast object.shapeType == "process"
    ...  # text_update {objectId, content: "Проверка"} -> broadcast text_update, content
def test_flow_block_rotation_is_zero(...):
    ...  # object_transform rotation=45 -> сохранён rotation == 0
```

- [ ] **Step 2: RED, затем реализовать сервер**

Run: `pytest tests/test_board_elements.py -q` → FAIL. Расширить Literal; в
`_handle_text_update` разрешить блоки и обновлять `content`; в `_handle_object_transform`
для `frame`/блока обнулять rotation. Прогнать → PASS.

- [ ] **Step 3: Падающий E2E блоков**

```js
test('flowchart: blocks with labels and free arrows', ...)
```
Создать три блока (P/D/S), подписать двойным кликом, изменить размер, убедиться, что поворота
нет (`Transformer.rotateEnabled()` false при выделении блока); свободная стрелка по-прежнему
рисуется. Run → FAIL.

- [ ] **Step 4: Реализовать фронт**

`index.html`: три кнопки `data-tool`; `TOOL_KEYS`; `_createShapeNode`/`_resizeShapeNode`/
`_applyTransform` для блочных типов и подписи; `_handleStageDoubleClick` для блоков;
`selectObject`: `rotateEnabled(false)` для блока/фрейма; стили иконок. Run E2E → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend frontend e2e/tests/board-elements.spec.js
git commit -m "feat: add flowchart blocks with labels"
```

---

### Task 4: Стрелки-коннекторы

**Files:**
- Modify: `backend/app/models/schemas.py` (`ConnectorAdd`, `ClientMessage`)
- Modify: `backend/app/api/ws.py` (dispatch, handler, delete cascade)
- Modify: `backend/app/services/room_manager.py` (`ADD_EVENTS`, scoped events, Redis sync/apply)
- Modify: `frontend/js/board.js`, `frontend/js/tools.js`, `frontend/js/main.js`
- Test: `backend/tests/test_board_elements.py`, `backend/tests/test_redis.py`,
  `e2e/tests/board-elements.spec.js`

**Interfaces:**
- `ConnectorAdd {type:"connector_add", objectId, fromId, toId, color, strokeWidth}`.
- Сервер: оба конца — существующие `shape` с `shapeType` из `FLOW_SHAPES` на той же
  странице, `fromId != toId`; создаёт объект `type:"connector"` через `_new_object`;
  broadcast `connector_add` **без exclude** (отправитель тоже получает).
- Удаление блока: сервер удаляет коннекторы с `fromId`/`toId` = блок; broadcast каждого
  удаления **без exclude**; одиночная цель по-прежнему exclude.
- Клиент: `Board._createConnectorNode`, `_connectorPoints(from, to)` (пересечение центр-линия
  с прямоугольником/ромбом/скруглённым прямоугольником), `updateConnectorsFor(blockId)`;
  коннектор без обоих блоков не создаётся; вызов при `object_update`/`object_transform`/
  `frame_moved`/`setObjects`.
- Инструмент «Стрелка»: если pointerdown/up попали в два разных блока — `connector_add`,
  без локального добавления (ждём событие); иначе существующая свободная стрелка.
- `selectObject`: коннектор выделяется, но `resizeEnabled(false)`/`rotateEnabled(false)`.

- [ ] **Step 1: Падающие backend-тесты**

```python
def test_connector_requires_two_flow_blocks(...):
    ...  # конец не блок -> error invalid_message, объекта нет
def test_connector_is_broadcast_to_sender(...):
    ...  # отправитель получает connector_add
def test_deleting_block_removes_its_connectors(...):
    ...  # после object_delete блока оба клиента получают object_delete коннектора
```

- [ ] **Step 2: RED, реализовать сервер и Redis**

Run: `pytest tests/test_board_elements.py -q` → FAIL. Добавить схему/dispatch/handler,
каскад в `_handle_object_delete` (Task 2), `connector_add` в `ADD_EVENTS` и
`WORKSPACE_SCOPED_EVENTS`; `_sync_redis_event` пишет объект, `_apply_remote_event` добавляет.
Тест Redis: второй менеджер видит коннектор. Run → PASS.

- [ ] **Step 3: Падающий E2E**

```js
test('flowchart: connectors follow blocks and disappear with them', ...)
```
Стрелка от процесса к решению; переместить блок — конец стрелки следует; изменить размер —
следует; удалить блок — стрелка исчезает у обоих; свободная стрелка от пустого места остаётся.

- [ ] **Step 4: Реализовать клиент**

Рендер `Konva.Arrow`, геометрия, пересчёт, обработка события `connector_add`, определение
блоков под курсором (`objectIdAt` + данные), запрет трансформаций коннектора. Run → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend frontend e2e/tests/board-elements.spec.js
git commit -m "feat: attach flowchart arrows to blocks"
```

---

### Task 5: Фреймы — сервер, привязка, каскады и Redis

**Files:**
- Modify: `backend/app/models/schemas.py` (`FrameAdd`, `FrameMove`, `FrameStyle`, `ClientMessage`)
- Modify: `backend/app/api/ws.py` (handlers, attachment, transform, delete cascade)
- Modify: `backend/app/services/room_manager.py` (events, Redis sync/apply)
- Test: `backend/tests/test_board_elements.py`, `backend/tests/test_redis.py`

**Interfaces:**
- Сообщения: `frame_add {objectId, x, y, width, height, fill, pattern, stroke, strokeWidth}`,
  `frame_move {objectId, x, y}`, `frame_style {objectId, fill, pattern}`.
- Серверные события: `frame_add {object}` (exclude sender), `frame_captured {frameId,
  objectIds, workspaceId}` (всем, включая создателя), `frame_moved {frameId, x, y,
  children:[{id,x,y}], workspaceId}` (всем), `frame_style {objectId, fill, pattern,
  workspaceId}` (exclude sender).
- `_frame_for(room, obj) -> str | None`: якорь — центр для shape/image, `x/y` для text;
  среди фреймов той же страницы; `frameId` отсутствует, если ни один не содержит.
- `_handle_shape_add`/`text_add`/`image_add`/`object_update`/`object_transform` вычисляют
  `frameId` и включают его в broadcast (для update — в сообщение).
- `_handle_frame_add`: объект `type:"frame"`, `rotation=0`; проверка лимита объектов; после
  добавления захватывает объекты без `frameId` внутри прямоугольника (нормализовать
  отрицательные width/height); broadcast `frame_captured` всем.
- `_handle_connector_add`: проверка лимита объектов на комнату.
- `_handle_frame_move`: проверка автор/стафф; дельта от старого `x/y`; сдвиг фрейма и всех
  детей (`frameId` = id, та же страница); broadcast `frame_moved` всем.
- `_handle_frame_style`: автор/стафф; обновить fill/pattern; broadcast.
- Удаление фрейма: дети + коннекторы, привязанные к блокам-детям; ученик может удалить
  только свой фрейм и только если все дети его; каскадные `object_delete` — всем. Правило
  встраивается в `_can_delete_object` из Task 2.
- Redis: `frame_add`/`connector_add` в `ADD_EVENTS`; `frame_moved`/`frame_captured`/
  `frame_style` в `WORKSPACE_SCOPED_EVENTS`; `_sync_redis_event`/`_apply_remote_event`
  обновляют фрейм, детей и `frameId`.

- [ ] **Step 1: Падающие backend-тесты**

```python
def test_frame_captures_existing_objects(...): ...  # frame_captured у создателя и зрителя
def test_frame_move_shifts_children_once(...): ...   # x += dx ровно один раз
def test_frame_style_updates_fill_and_pattern(...): ...
def test_frame_delete_removes_children_and_connectors(...): ...
def test_student_cannot_delete_foreign_frame_or_foreign_children(...): ...
def test_transform_recomputes_frame_id(...): ...     # вытащили ребёнка -> frameId нет
```
Плюс Redis-тест: `frame_moved` на manager A двигает детей у manager B.

- [ ] **Step 2: RED, реализовать**

Run: `pytest tests/test_board_elements.py tests/test_redis.py -q` → FAIL. Реализовать схемы,
хендлеры, привязку, каскады, Redis. Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add backend
git commit -m "feat: add frames with captured children"
```

---

### Task 6: Фреймы — клиент, фон, перемещение детей и панель

**Files:**
- Modify: `frontend/js/board.js`, `frontend/js/tools.js`, `frontend/js/main.js`,
  `frontend/index.html`, `frontend/css/style.css`
- Test: `e2e/tests/board-elements.spec.js`

**Interfaces:**
- `Board._createFrameNode(object)`: группа с фоном (Rect), паттерном (`Konva.Shape`,
  `lines`/`grid`, шаг 24 px, клип по прямоугольнику) и рамкой; добавляется `moveToBottom()`.
- `Board._frameFor(data) -> string | null` — локальное зеркало серверной привязки;
  применяется в `addObject` и после `updateObjectPosition`/`_applyTransform` для
  shape/text/image.
- `Board` drag фрейма: на `dragstart` запомнить позиции фрейма и детей; `dragmove` двигать
  детей на дельту; `dragend` отправить `frame_move` (через `onFrameMove` option/main).
- `Board.applyFrameMove(message)`, `Board.setFrameChildren(frameId, ids)`,
  `Board.selectObject` колбэк `onSelectObject(id)`.
- Инструмент `frame` (тянет прямоугольник), `data-tool="frame"`, `F`.
- Панель `#frame-panel` (скрыта): кнопки `#frame-pattern-none|lines|grid`, палитра
  `#frame-colors`; показывается при выделении редактируемого фрейма; изменения —
  `frame_style`, локально `board.applyObjectTransform`.
- Удаление фрейма Delete — confirm «Удалить фрейм и всё содержимое?»; ластик — без вопроса.
- Ластик: фрейм задевается только по рамке (полоса `strokeWidth + radius`); ученик не может
  стереть фрейм с чужими детьми (клиентский фильтр + сервер).
- Создание фрейма локально тоже захватывает объекты без `frameId` (зеркало сервера);
  `object_update` с `frameId` обновляет локальную привязку; `frame_style` применяет фон.

- [ ] **Step 1: Падающий E2E**

```js
test('frames: backgrounds, captured children and moving together', ...)
test('frames: drag out detaches and delete removes content', ...)
test('frames: student cannot erase a frame with foreign children', ...)
```
Создать фрейм, включить заливку/линии/клетку, бросить блок/картинку внутрь, подвинуть фрейм —
дети сместились; вытащить ребёнка — он открепился (после `frame_moved`/reload); изменить
размер — дети на местах; удалить фрейм с подтверждением — содержимое исчезло.

- [ ] **Step 2: RED, реализовать рендер/поведение**

Run: `npx.cmd playwright test tests/board-elements.spec.js --reporter=line` → FAIL.
Реализовать `_createFrameNode`, паттерны, привязку, drag, события, панель, confirm,
ластик по рамке. Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend e2e/tests/board-elements.spec.js
git commit -m "feat: add frames with backgrounds and child movement"
```

---

### Task 7: Интеграция ластика с блоками/фреймами, полный регресс и документация

**Files:**
- Modify: `e2e/tests/board-elements.spec.js` (сценарии каскадов ластика)
- Modify: `README.md`, `plan.md`
- Test: весь backend + E2E

**Interfaces:**
- Ластик по блоку удаляет его коннекторы (через `object_delete` каскад); по рамке фрейма —
  фрейм и содержимое; по ребёнку — только ребёнка.
- README: новые инструменты, горячие клавиши, поведение ластика/фреймов/схем; plan.md: P6.

- [ ] **Step 1: Дописать E2E каскадов**

```js
test('eraser: removes a block with its arrows and a frame with its content', ...)
```
RED→GREEN по мере необходимости.

- [ ] **Step 2: Полный регресс**

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

Expected: всё зелёное; compose exit 0.

- [ ] **Step 3: Документация**

README: палитра (процесс/решение/начало-конец/фрейм), стрелки-коннекторы, фон фрейма,
ластик удаляет объекты (стафф/автор), картинки двигаются сразу. plan.md: секция P6 с
чекбоксами, журнал, актуальные числа тестов. Убрать устаревшие описания пиксельного ластика.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: describe board elements and frames"
```
