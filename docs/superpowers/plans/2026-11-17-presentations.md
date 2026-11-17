# Презентации как воркспейсы: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить страницы-презентации из PDF: учитель листает слайды и рисует только кистью, ученик только смотрит; пометки хранятся по слайдам.

**Architecture:** PDF конвертируется на сервере в JPEG-слайды (pypdfium2 + Pillow) и хранится в существующем ImageStorage. Воркспейс получает `kind/slides/slideIndex`; штрихи — объекты с полем `slide`; сервер фильтрует объекты по текущему слайду и запрещает на презентации всё, кроме кисти staff.

**Tech Stack:** FastAPI, Pydantic, pypdfium2, Pillow, WebSocket, Redis, Konva.js, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-presentation-workspaces-design.md`

## Global Constraints

- Принимаются только PDF; PPTX/LibreOffice не добавляем.
- Лимиты: 40 МБ, 80 слайдов, ширина слайда 1600 px.
- Новые Python-зависимости: `pypdfium2`, `Pillow`; новых JS-зависимостей нет.
- Нормальные воркспейсы остаются `{id,name,position}` без поля `kind`.
- Сервер, а не только UI, проверяет права презентации.
- Русские тексты ошибок; стиль кода существующий.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.

## Review Focus

- PDF с портретными/разноразмерными страницами не должен искажать пропорции.
- Битый/зашифрованный/слишком большой PDF и файл не-PDF должны давать понятную ошибку.
- Ученик не должен суметь изменить презентацию через сырые WS-сообщения.
- Смена слайда во время рисования не должна оставлять «зависший» штрих.
- Штрихи одного слайда не должны протекать на другой слайд после reconnect/смены страницы.

---

### Task 1: Метаданные презентации и фильтрация объектов

**Files:**
- Modify: `backend/app/services/workspaces.py`
- Modify: `backend/app/services/room_manager.py`
- Test: `backend/tests/test_workspaces.py`, `backend/tests/test_room_manager.py`

**Interfaces:**
- Produces:
  - `PRESENTATION_KIND = "presentation"`, `MAX_PRESENTATION_SLIDES = 80`
  - `normalize_workspaces(raw)` сохраняет `kind/slides/slideIndex` только для презентаций.
  - `Room.add_workspace(name, kind="page", slides=None) -> dict`
  - `RoomManager.create_workspace(room, name=None, kind="page", slides=None) -> dict`
  - `RoomManager.objects_for(room, workspace_id)` фильтрует по `slideIndex` для презентации.

- [ ] **Step 1: Написать падающие unit-тесты**

В `test_workspaces.py`:

```python
def test_normalize_preserves_presentation() -> None:
    raw = [{
        "id": "ws_p", "name": "Урок", "position": 3,
        "kind": "presentation",
        "slides": ["/uploads/a.jpg", "/uploads/b.jpg"],
        "slideIndex": 1,
    }]
    assert normalize_workspaces(raw) == [{
        "id": "ws_p", "name": "Урок", "position": 0,
        "kind": "presentation",
        "slides": ["/uploads/a.jpg", "/uploads/b.jpg"],
        "slideIndex": 1,
    }]


def test_normalize_clamps_slides_and_index() -> None:
    raw = [{
        "id": "ws_p", "name": "Урок", "position": 0,
        "kind": "presentation", "slides": ["/uploads/a.jpg"], "slideIndex": 99,
    }]
    workspace = normalize_workspaces(raw)[0]
    assert workspace["slideIndex"] == 0
    assert workspace["slides"] == ["/uploads/a.jpg"]
```

В `test_room_manager.py`:

```python
async def test_objects_for_filters_presentation_slide(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    workspace = manager.create_workspace(
        room, "Урок", kind="presentation", slides=["/uploads/a.jpg", "/uploads/b.jpg"]
    )
    manager.add_object(room, {**SAMPLE_OBJECT, "id": "s0", "slide": 0}, workspace["id"])
    manager.add_object(room, {**SAMPLE_OBJECT, "id": "s1", "slide": 1}, workspace["id"])
    assert [obj["id"] for obj in manager.objects_for(room, workspace["id"])] == ["s0"]
    workspace["slideIndex"] = 1
    assert [obj["id"] for obj in manager.objects_for(room, workspace["id"])] == ["s1"]
    await manager.shutdown()
    await store.close()
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py tests/test_room_manager.py -q -p no:warnings`
Expected: FAIL — `kind/slides` отбрасываются, `create_workspace` не принимает аргументы.

- [ ] **Step 3: Реализовать нормализацию**

В `workspaces.py`:

- константы `PRESENTATION_KIND`, `MAX_PRESENTATION_SLIDES`;
- в цикле `normalize_workspaces` после `name`:

```python
workspace = {"id": workspace_id, "name": name, "position": _position(item.get("position"))}
if item.get("kind") == PRESENTATION_KIND:
    slides = [
        slide for slide in item.get("slides") or []
        if isinstance(slide, str) and 1 <= len(slide) <= 500
    ][:MAX_PRESENTATION_SLIDES]
    index = item.get("slideIndex")
    index = index if isinstance(index, int) and not isinstance(index, bool) else 0
    workspace.update(
        kind=PRESENTATION_KIND,
        slides=slides,
        slideIndex=min(max(index, 0), max(len(slides) - 1, 0)),
    )
workspaces.append(workspace)
```

- [ ] **Step 4: Реализовать модель комнаты**

`Room.add_workspace`:

```python
def add_workspace(self, name: str, kind: str = "page", slides: list[str] | None = None) -> dict[str, Any]:
    workspace = {"id": new_workspace_id(), "name": name, "position": ...}
    if kind == PRESENTATION_KIND:
        workspace.update(kind=PRESENTATION_KIND, slides=list(slides or []), slideIndex=0)
    self.workspaces[workspace["id"]] = workspace
    return workspace
```

`RoomManager.create_workspace(room, name=None, kind="page", slides=None)` передаёт параметры в `room.add_workspace`.

`RoomManager.objects_for`:

```python
objects = room.objects_in(workspace_id)
workspace = room.get_workspace(workspace_id)
if workspace is not None and workspace.get("kind") == PRESENTATION_KIND:
    slide = int(workspace.get("slideIndex", 0) or 0)
    return [obj for obj in objects if int(obj.get("slide", 0) or 0) == slide]
return objects
```

- [ ] **Step 5: Прогнать тесты**

Run: то же.
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add backend/app/services/workspaces.py backend/app/services/room_manager.py backend/tests/test_workspaces.py backend/tests/test_room_manager.py
git commit -m "feat: add presentation workspace metadata"
```

---

### Task 2: Загрузка PDF и рендер слайдов

**Files:**
- Modify: `backend/requirements.txt`, `backend/app/config.py`, `backend/app/api/upload.py`, `.env.example`
- Test: `backend/tests/test_presentations.py` (create), `backend/tests/fixtures/two-slides.pdf` (create)

**Interfaces:**
- Produces:
  - `POST /api/presentations` (staff, multipart `file`) → `{slides: list[str], pageCount: int}`
  - `Settings.max_presentation_mb = 40`, `Settings.max_presentation_slides = 80`

- [ ] **Step 1: Создать PDF-фикстуру**

`backend/tests/fixtures/two-slides.pdf` — две страницы 200×100 с текстом
`Slide 1` / `Slide 2`. В тесте она читается как bytes; файл должен начинаться
с `%PDF-1.4`.

- [ ] **Step 2: Написать падающие тесты**

```python
from pathlib import Path

from fastapi.testclient import TestClient
from tests.support import login_user  # или фикстура login_user

PDF = (Path(__file__).parent / "fixtures" / "two-slides.pdf").read_bytes()


def cookie(token: str) -> dict[str, str]:
    return {"wb_session": token}


def test_presentations_require_staff(client: TestClient, login_user) -> None:
    student = login_user("Ученик", "student")
    response = client.post(
        "/api/presentations",
        cookies=cookie(student["token"]),
        files={"file": ("slides.pdf", PDF, "application/pdf")},
    )
    assert response.status_code == 403


def test_presentations_render_slides(client: TestClient, login_user, settings) -> None:
    teacher = login_user("Учитель", "teacher")
    response = client.post(
        "/api/presentations",
        cookies=cookie(teacher["token"]),
        files={"file": ("slides.pdf", PDF, "application/pdf")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pageCount"] == 2
    assert len(body["slides"]) == 2
    for url in body["slides"]:
        assert url.startswith("/uploads/")
        assert (settings.uploads_dir / url.removeprefix("/uploads/")).is_file()
        assert client.get(url).status_code == 200


def test_presentations_reject_non_pdf(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    response = client.post(
        "/api/presentations",
        cookies=cookie(teacher["token"]),
        files={"file": ("slides.txt", b"not a pdf", "application/pdf")},
    )
    assert response.status_code == 415
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_presentations.py -q -p no:warnings`
Expected: FAIL — 404/405.

- [ ] **Step 4: Добавить зависимости и настройки**

`requirements.txt`: `pypdfium2>=4.30,<5.0`, `Pillow>=10,<13.0`.
`config.py`: `max_presentation_mb: int = 40`, `max_presentation_slides: int = 80`.
`.env.example`: `MAX_PRESENTATION_MB=40`, `MAX_PRESENTATION_SLIDES=80`.

- [ ] **Step 5: Реализовать endpoint**

В `upload.py`:

```python
@router.post("/presentations")
async def upload_presentation(
    file: Annotated[UploadFile, File()],
    user: Annotated[User, Depends(get_auth_user)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    images: Annotated[ImageStorage, Depends(get_image_storage)],
) -> dict[str, object]:
```

- `is_staff(user.role)` иначе 403;
- content type `application/pdf` и сигнатура `%PDF-`, иначе 415;
- размер `max_presentation_mb`; пустой файл 400;
- `pypdfium2.PdfDocument(data)`; ошибки → 400;
- число страниц 1..`max_presentation_slides`, иначе 400/413;
- для каждой страницы: render scale = 1600 / page width, `to_pil().convert("RGB")`,
  сохранить JPEG quality 88 в `BytesIO`, `images.save(f"{uuid.hex}-{index+1}.jpg", data, "image/jpeg")`;
- `metrics.UPLOAD_BYTES.inc(...)` на общий размер;
- вернуть `{"slides": urls, "pageCount": len(urls)}`;
- закрывать page/bitmap/pdf в `finally`.

- [ ] **Step 6: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_presentations.py -q -p no:warnings`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add backend/requirements.txt backend/app/config.py backend/app/api/upload.py .env.example backend/tests/test_presentations.py backend/tests/fixtures/two-slides.pdf
git commit -m "feat: render uploaded presentations into slides"
```

---

### Task 3: WebSocket: создание, слайды и права

**Files:**
- Modify: `backend/app/models/schemas.py`, `backend/app/api/ws.py`, `backend/app/services/room_manager.py`
- Test: `backend/tests/test_presentations_ws.py` (create), `backend/tests/test_workspaces.py`, `backend/tests/test_redis.py`

**Interfaces:**
- Consumes: Task 1 `kind/slides/slideIndex`, `objects_for`; Task 2 upload URL.
- Produces:
  - `PresentationSlide(_Message)` с `workspaceId: str | None`, `slideIndex: int`
  - `WorkspaceCreate.kind`, `WorkspaceCreate.slides`
  - событие `presentation_slide {workspaceId, slideIndex, objects}`
  - `RoomManager.finalize_user_strokes(room, user)`
  - презентационный whitelist в `_handle_message`.

- [ ] **Step 1: Написать падающие schema-тесты**

В `test_workspaces.py`:

```python
def test_presentation_messages_parse() -> None:
    created = WorkspaceCreate.model_validate({
        "type": "workspace_create", "name": "Урок", "kind": "presentation",
        "slides": ["/uploads/a.jpg"],
    })
    assert created.kind == "presentation"
    assert created.slides == ["/uploads/a.jpg"]
    assert WorkspaceCreate.model_validate({"type": "workspace_create"}).kind == "page"
    slide = client_message_adapter.validate_python({
        "type": "presentation_slide", "workspaceId": "ws_default", "slideIndex": 2,
    })
    assert slide.type == "presentation_slide"
    with pytest.raises(ValidationError):
        WorkspaceCreate.model_validate({
            "type": "workspace_create", "kind": "presentation", "slides": ["not a url"],
        })
```

- [ ] **Step 2: Написать падающие WS-тесты**

`test_presentations_ws.py` (использовать `ws_connect`, `recv_until`, `barrier` из соседних тестов):

- загрузка PDF через REST → `slides`;
- teacher `workspace_create` kind presentation → `workspace_created` с `kind/slides`, затем `workspace_state` slideIndex 0;
- student получает `workspace_created`;
- teacher brush `stroke_start/point/end` → student получает stroke, объект имеет `slide: 0`;
- teacher `presentation_slide` 1 → оба получают событие, `objects == []`, `slideIndex == 1`;
- teacher рисует на слайде 1; возврат на 0 → в `objects` только штрих слайда 0;
- student `presentation_slide` → `forbidden`;
- student `stroke_start` → `presentation_brush_only`;
- teacher `shape_add`, `object_delete`, `clear`, `undo` → `presentation_view_only`;
- student `workspace_switch` на обычную страницу работает.

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py tests/test_presentations_ws.py -q -p no:warnings`
Expected: FAIL — неизвестные схемы/поля.

- [ ] **Step 4: Добавить схемы**

`WorkspaceCreate`:

```python
kind: Literal["page", "presentation"] = "page"
slides: list[Annotated[str, Field(pattern=UPLOAD_URL_PATTERN)]] = Field(
    default_factory=list, max_length=80
)
```

`PresentationSlide`:

```python
class PresentationSlide(_Message):
    type: Literal["presentation_slide"]
    workspaceId: str | None = Field(default=None, pattern=WORKSPACE_ID_PATTERN)
    slideIndex: int = Field(ge=0, le=1000)
```

Добавить в `ClientMessage`.

- [ ] **Step 5: Реализовать whitelist и проверки штрихов**

В `ws.py`:

```python
PRESENTATION_ALLOWED = {
    "stroke_start", "stroke_point", "stroke_end", "cursor",
    "presentation_slide", "kick",
    "workspace_switch", "workspace_create", "workspace_rename",
    "workspace_delete", "workspace_reorder", "workspace_pull",
    "workspace_move_ack",
}

def _is_presentation(room: Room, workspace_id: str) -> bool:
    workspace = room.get_workspace(workspace_id)
    return bool(workspace and workspace.get("kind") == "presentation")
```

В начале `_handle_message` после rate limit:

```python
if _is_presentation(room, user.workspace_id) and message.type not in PRESENTATION_ALLOWED:
    await manager.send_to(user, _error("presentation_view_only", "На презентации можно только рисовать кистью"))
    return
```

В `_handle_stroke_start` перед созданием объекта:

```python
presentation = _is_presentation(room, user.workspace_id)
if presentation and (not is_staff(user.role) or message.tool != "brush"):
    await manager.send_to(user, _error("presentation_brush_only", "На презентации доступна только кисть учителя"))
    return
...
obj = _new_object(
    ..., **({"slide": int(room.get_workspace(user.workspace_id).get("slideIndex", 0))} if presentation else {}),
)
```

- [ ] **Step 6: Создание презентации и смена слайда**

`_handle_workspace_create`: для `message.kind == "presentation"`:

```python
if not message.slides:
    error("invalid_presentation", "В презентации нет слайдов"); return
for url in message.slides:
    if not await manager.images.exists(url):
        error("invalid_presentation", "Слайд не найден"); return
workspace = manager.create_workspace(
    room, message.name or "Презентация", kind="presentation", slides=message.slides
)
```

`_handle_presentation_slide`:

- staff, `_check_workspace`;
- workspace presentation, индекс в диапазоне;
- `await manager.finalize_user_strokes(room, user)`;
- обновить `slideIndex`, `manager.mark_dirty`;
- broadcast `{type: "presentation_slide", workspaceId, slideIndex, objects: manager.objects_for(...)}` без exclude;
- ветка в `_handle_message`; очистка истории при смене слайда не нужна (undo запрещён).

`RoomManager.finalize_user_strokes` — публичная обёртка над `_finalize_strokes`.

- [ ] **Step 7: workspace_state/init и Redis**

- В `switch_workspace` в оба `workspace_state` добавить `slideIndex` для презентации.
- `WORKSPACE_SCOPED_EVENTS` += `presentation_slide`.
- `_sync_redis_event`: `presentation_slide` → `await self._write_workspaces(room)`.
- `_apply_remote_event`: обновить `workspace["slideIndex"]`, `changed=True`.
- `objects_for` уже фильтрует (Task 1).

- [ ] **Step 8: Redis-тест**

В `test_redis.py`: manager A создаёт презентацию (workspace dict с kind/slides), broadcast `workspace_created`, manager B видит `slides`; broadcast `presentation_slide` с индексом 1, manager B видит `slideIndex == 1`.

- [ ] **Step 9: Прогнать тесты**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py tests/test_presentations_ws.py tests/test_redis.py tests/test_room_manager.py -q -p no:warnings`
Expected: PASS.

- [ ] **Step 10: Коммит**

```bash
git add backend/app/models/schemas.py backend/app/api/ws.py backend/app/services/room_manager.py backend/tests/test_presentations_ws.py backend/tests/test_workspaces.py backend/tests/test_redis.py
git commit -m "feat: present slides and restrict presentation tools"
```

---

### Task 4: Клиент: загрузка, слайды, режим просмотра

**Files:**
- Modify: `frontend/index.html`, `frontend/css/style.css`, `frontend/js/pages.js`, `frontend/js/board.js`, `frontend/js/main.js`
- Test: `e2e/tests/presentations.spec.js` (create)

**Interfaces:**
- Consumes: `POST /api/presentations`, `WorkspaceCreate` kind/slides, `presentation_slide`.
- Produces:
  - `Board.setPresentationSlide(url: string | null): Promise<void>`
  - `Board.clearPresentationSlide(): void`
  - `main.js`: `isPresentation()`, `applyWorkspaceMode()`, `updateSlideControls()`, `uploadPresentation()`.

- [ ] **Step 1: Написать падающий E2E**

`e2e/tests/presentations.spec.js`, фикстура `../backend/tests/fixtures/two-slides.pdf`:

- teacher открывает комнату, `setInputFiles('#presentation-input', fixture)`;
- страница появляется в панели, счётчик `1 / 2`, в фоне есть `.slide-bg`;
- видна только кнопка `[data-tool="brush"]`; остальные инструменты скрыты;
- учитель рисует кистью → объект есть; `#slide-next` → счётчик `2 / 2`, объектов 0;
- учитель рисует на слайде 2; `#slide-prev` → счётчик `1 / 2`, снова один объект;
- student открывает комнату, переходит на страницу презентации: видит `.slide-bg`, счётчик, не видит инструментов и `#slide-next`; рисует мышью — объект не появляется; видит штрихи учителя.

- [ ] **Step 2: Убедиться, что E2E падает**

Run: `npx.cmd playwright test tests/presentations.spec.js --timeout=20000`
Expected: FAIL — нет `#presentation-input`/страницы.

- [ ] **Step 3: HTML/CSS**

- `#presentation-input` (hidden, accept `.pdf,application/pdf`).
- `#slide-controls` с `#slide-prev`, `#slide-counter`, `#slide-next`, `hidden`.
- CSS: абсолютное позиционирование внизу `.workspace`, кнопки, счётчик; скрытие на мобильных при необходимости.
- `PagesPanel`: кнопка «+ Презентация» (`onCreatePresentation`), значок у страниц `kind === 'presentation'`.

- [ ] **Step 4: Фон слайда**

В `Board`:

- `this.slideImage = null`, `this.slideToken = 0`.
- `async setPresentationSlide(url)`:
  - увеличить token, удалить старый узел;
  - при `null` показать сетку и выйти;
  - загрузить Image, вписать contain в 1600×900, центрировать;
  - `Konva.Image({ name: 'slide-bg', listening: false, ... })`, добавить в `backgroundLayer`, `moveToTop()`, скрыть `grid`.
  - игнорировать устаревший ответ по token.
- `clearPresentationSlide()` — удалить узел, показать сетку.

- [ ] **Step 5: Режим презентации в main.js**

- `presentationWorkspace()` / `isPresentation()`.
- `applyWorkspaceMode()`:
  - скрыть/показать `.tool` кнопки: teacher — только `brush`, student — все;
  - скрыть image/undo/lock/pdf/clear, frame panel, colors/width для ученика;
  - teacher: `selectTool('brush')`, `setInteractive(true)`;
  - student: `setTool('select')` без board-интерактива, `setInteractive(false)`, `selectObject(null)`, закрыть редактор;
  - загрузить `slides[slideIndex]`, `updateSlideControls()`;
  - на обычной странице вернуть все кнопки, `setInteractive(true)`, очистить слайд.
- `handleWorkspaceState`/`handleInit` вызывают `applyWorkspaceMode()` после `setObjects`.
- `handleWorkspaceCreated` добавляет страницу; если текущая — режим.
- `handlePresentationSlide(message)`:
  - обновить `slideIndex` в `state.workspaces`;
  - `state.board.setObjects(message.objects || [])`;
  - `setPresentationSlide(currentUrl)`;
  - `updateSlideControls()`.
- `#slide-prev`/`#slide-next` → `sendWorkspace({type:'presentation_slide', slideIndex})`.
- Клавиши `←`/`→` для staff на презентации.
- `selectTool`, `requestUndo`, `handlePaste`, Delete/F2, PDF — не работают на презентации.
- `uploadPresentation()`: staff, POST, затем `workspace_create` с именем файла и slides; ошибки тостом.

- [ ] **Step 6: Прогнать E2E**

Run: `npx.cmd playwright test tests/presentations.spec.js`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add frontend/index.html frontend/css/style.css frontend/js/pages.js frontend/js/board.js frontend/js/main.js e2e/tests/presentations.spec.js
git commit -m "feat: presentation pages in the board UI"
```

---

### Task 5: Документация и регрессия

**Files:**
- Modify: `README.md`, `plan.md`, `docs/deploy-vds.md` (лимиты/зависимости)

- [ ] **Step 1: README**

Описать новый тип страницы, загрузку PDF, листание, только кисть, просмотр учеником, лимиты 40 МБ/80 слайдов, пометки по слайдам.

- [ ] **Step 2: plan.md**

Раздел P9 с чекбоксами и фактическими числами тестов.

- [ ] **Step 3: Полный прогон**

- backend: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`
- `ruff check .`, `black --check .`
- E2E: `npx.cmd playwright test`
- `docker compose config --quiet`

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md docs/deploy-vds.md
git commit -m "docs: describe presentation workspaces"
```

---

## Self-Review

- **Спека:** PDF-only upload (Task 2), метаданные/фильтрация (Task 1), WS-права и слайды
  (Task 3), UI/просмотр (Task 4), документация (Task 5).
- **Review Focus → тесты:** портретные PDF проверяются рендером по ширине и contain;
  битые PDF и права (Task 2/3); ученик через сырой WS (Task 3); смена слайда во время
  штриха (Task 3 finalize); изоляция слайдов после reconnect/смены страницы (Task 3,
  Redis/снимок).
- **Типы:** `kind/slides/slideIndex` одинаково в нормализации, WS и клиенте;
  `objects_for` — единственная точка фильтрации; `PresentationSlide` и
  `WorkspaceCreate` согласованы с union.
- **Пропорция:** план задаёт сигнатуры, данные и проверки; тела рендера/PDF-конвертации
  не переписываются целиком.
