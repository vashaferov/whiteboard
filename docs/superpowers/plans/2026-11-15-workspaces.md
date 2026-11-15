# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple pages (workspaces) to a room, with per-user switching and teacher-driven pull, preserving all existing rooms.

**Architecture:** Keep one flat object list per room and add `workspaceId` to every object. The room stores ordered workspace metadata. Broadcasts filter by the recipient's current workspace; SQLite snapshots gain a `workspaces` column and Redis gains a workspaces hash. Teacher pull is two-phase: prepare → client commits its draft/stroke → ack → move.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, SQLite, redis-py, pytest, vanilla JS ES modules, Konva 9, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-workspaces-design.md`

## Global Constraints

- Workspace ids: `ws_default` for the first page, `ws_<uuidhex>` for new pages; pattern `^ws_[A-Za-z0-9_-]{1,64}$`.
- Every room always has at least one workspace; the last workspace cannot be deleted.
- Default page name: `Страница 1`; names are trimmed and must be 1…60 characters.
- Maximum 50 workspaces per room (`MAX_WORKSPACES_PER_ROOM`, default `50`).
- Pull acknowledgement timeout: `WORKSPACE_MOVE_TIMEOUT_SECONDS`, default `2.0`.
- Only teachers may create/rename/delete/reorder workspaces and pull students; all users may switch their own workspace.
- Pulled students stay on the target page after the teacher switches again.
- Object/cursor/clear messages may carry `workspaceId`; a mismatching value is rejected as `stale_workspace`.
- `Permissions` gains `canManageWorkspaces`; existing `canManageUsers` governs pull.
- No new runtime dependencies.
- Project is currently not a git repository. Run the `Commit` step only if the executor has initialized git; otherwise skip it and leave changes in the working tree.
- Backend commands run from `backend/` with `..\.venv\Scripts\python.exe`; E2E commands run from `e2e/` with `PYTHON` pointing at the venv.

## Review Focus

- Teacher switches page: students must not follow; only an explicit pull moves them.
- A stale object/cursor event after switch or pull must not land on the new page.
- Deleting a non-last page moves every viewer, including the teacher, to the first remaining page; deleting the last page is rejected.
- A legacy snapshot or Redis state without workspaces must not lose objects or split them across pages.
- Pull timeout, stale ack, disconnect, and a manual switch racing a pull must not leave a client on an outdated page or apply the move twice.

---

### Task 1: Workspace primitives, settings, and protocol schemas

**Files:**
- Create: `backend/app/services/workspaces.py`
- Modify: `backend/app/config.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `.env.example`
- Test: `backend/tests/test_workspaces.py`
- Test: `backend/tests/test_api.py:31-36`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_WORKSPACE_ID: str`, `DEFAULT_WORKSPACE_NAME: str`
  - `def new_workspace_id() -> str`
  - `def default_workspace() -> dict[str, Any]`
  - `def normalize_workspaces(raw: Any) -> list[dict[str, Any]]`
  - `def assign_orphan_objects(workspaces: list[dict[str, Any]], objects: list[dict[str, Any]]) -> None`
  - `def next_workspace_name(workspaces: list[dict[str, Any]]) -> str`
  - `Settings.max_workspaces_per_room: int`, `Settings.workspace_move_timeout_seconds: float`
  - Pydantic models: `WorkspaceSwitch`, `WorkspaceCreate`, `WorkspaceRename`, `WorkspaceDelete`, `WorkspaceReorder`, `WorkspacePull`, `WorkspaceMoveAck`
  - `Permissions.canManageWorkspaces`
  - `WORKSPACE_REQUEST_PATTERN = r"^mv_[a-f0-9]{32}$"`

- [ ] **Step 1: Write the failing primitives test**

Create `backend/tests/test_workspaces.py`:

```python
from app.services.workspaces import (
    DEFAULT_WORKSPACE_ID,
    assign_orphan_objects,
    default_workspace,
    next_workspace_name,
    normalize_workspaces,
)


def test_normalize_empty_creates_default() -> None:
    assert normalize_workspaces(None) == [
        {"id": DEFAULT_WORKSPACE_ID, "name": "Страница 1", "position": 0}
    ]
    assert default_workspace()["id"] == DEFAULT_WORKSPACE_ID


def test_normalize_sorts_drops_duplicates_and_repairs_positions() -> None:
    raw = [
        {"id": "ws_b", "name": "  Вторая  ", "position": 9},
        {"id": "ws_a", "name": "Первая", "position": 1},
        {"id": "ws_a", "name": "Дубль", "position": 2},
        {"id": "bad id", "name": "Плохая", "position": 3},
    ]
    assert normalize_workspaces(raw) == [
        {"id": "ws_a", "name": "Первая", "position": 0},
        {"id": "ws_b", "name": "Вторая", "position": 1},
    ]


def test_assign_orphan_objects_moves_them_to_first_workspace() -> None:
    workspaces = [
        {"id": "ws_a", "name": "Первая", "position": 0},
        {"id": "ws_b", "name": "Вторая", "position": 1},
    ]
    objects = [
        {"id": "o1"},
        {"id": "o2", "workspaceId": "ws_b"},
        {"id": "o3", "workspaceId": "missing"},
    ]
    assign_orphan_objects(workspaces, objects)
    assert [obj["workspaceId"] for obj in objects] == ["ws_a", "ws_b", "ws_a"]


def test_next_workspace_name_skips_existing_numbers() -> None:
    workspaces = [
        {"id": "ws_a", "name": "Страница 1", "position": 0},
        {"id": "ws_b", "name": "Страница 3", "position": 1},
        {"id": "ws_c", "name": "Черновик", "position": 2},
    ]
    assert next_workspace_name(workspaces) == "Страница 4"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py -q`
Expected: FAIL with `ModuleNotFoundError: app.services.workspaces`.

- [ ] **Step 3: Implement `backend/app/services/workspaces.py`**

Implement `normalize_workspaces` to accept any input, keep only dicts whose `id` matches the workspace pattern and whose `name` trims non-empty, drop duplicate ids, sort by integer `position` (missing → large value), and reassign positions `0..n-1`. If nothing remains, return `[default_workspace()]`.

Implement `assign_orphan_objects` to collect valid ids and set `obj["workspaceId"] = first_id` when the current value is missing or unknown.

Implement `next_workspace_name` by scanning names matching `Страница (\d+)`, adding 1 to the maximum, and falling back to `Страница {len(workspaces) + 1}`.

- [ ] **Step 4: Run the primitives test**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py -q`
Expected: PASS.

- [ ] **Step 5: Write the failing schema/permissions tests**

Append to `backend/tests/test_workspaces.py`:

```python
import pytest
from pydantic import ValidationError

from app.models.schemas import (
    Permissions,
    WorkspaceCreate,
    WorkspacePull,
    WorkspaceRename,
    WorkspaceReorder,
    WorkspaceSwitch,
    client_message_adapter,
    permissions_for,
)


def test_workspace_messages_parse() -> None:
    assert WorkspaceSwitch.model_validate(
        {"type": "workspace_switch", "workspaceId": "ws_default"}
    ).workspaceId == "ws_default"
    assert WorkspaceCreate.model_validate({"type": "workspace_create"}).name is None
    assert WorkspaceRename.model_validate(
        {"type": "workspace_rename", "workspaceId": "ws_a", "name": "Новая"}
    ).name == "Новая"
    assert WorkspaceReorder.model_validate(
        {"type": "workspace_reorder", "workspaceIds": ["ws_a", "ws_b"]}
    ).workspaceIds == ["ws_a", "ws_b"]
    assert client_message_adapter.validate_python(
        {"type": "workspace_switch", "workspaceId": "ws_default"}
    ).type == "workspace_switch"


def test_pull_requires_exactly_one_mode() -> None:
    with pytest.raises(ValidationError):
        WorkspacePull.model_validate({"type": "workspace_pull"})
    with pytest.raises(ValidationError):
        WorkspacePull.model_validate(
            {"type": "workspace_pull", "all": True, "clientIds": ["u1"]}
        )
    assert WorkspacePull.model_validate({"type": "workspace_pull", "all": True}).all is True
    assert WorkspacePull.model_validate(
        {"type": "workspace_pull", "clientIds": ["u1"]}
    ).clientIds == ["u1"]


def test_reorder_rejects_duplicates() -> None:
    with pytest.raises(ValidationError):
        WorkspaceReorder.model_validate(
            {"type": "workspace_reorder", "workspaceIds": ["ws_a", "ws_a"]}
        )


def test_teacher_can_manage_workspaces() -> None:
    assert permissions_for("teacher").canManageWorkspaces is True
    assert permissions_for("student").canManageWorkspaces is False
```

In `backend/tests/test_api.py`, add `"canManageWorkspaces": False` to the expected student permissions dict.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py tests/test_api.py -q`
Expected: FAIL because the models and permission field do not exist.

- [ ] **Step 7: Add settings and schemas**

In `config.py` add `max_workspaces_per_room: int = 50` and `workspace_move_timeout_seconds: float = 2.0` after `max_objects_per_room`.

In `.env.example` add `MAX_WORKSPACES_PER_ROOM=50` and `WORKSPACE_MOVE_TIMEOUT_SECONDS=2.0` under the limits section.

In `schemas.py`:
- add `WORKSPACE_ID_PATTERN = r"^ws_[A-Za-z0-9_-]{1,64}$"`;
- add `canManageWorkspaces: bool` to `Permissions` and set it to `is_teacher` in `permissions_for`;
- add `workspaceId: str | None = Field(default=None, pattern=WORKSPACE_ID_PATTERN)` to `_Message`;
- define the seven models. `WorkspacePull` uses `clientIds: list[str] = Field(default_factory=list, max_length=100)` and `all: bool = False`, with a `model_validator(mode="after")` that raises unless exactly one mode is set and every `clientIds` item matches `OBJECT_ID_PATTERN`. `WorkspaceReorder` uses `workspaceIds: list[str] = Field(min_length=1, max_length=50)` and validators rejecting duplicates and non-`WORKSPACE_ID_PATTERN` items. `WorkspaceRename.name` and `WorkspaceCreate.name` use `min_length=1, max_length=60`. `WorkspaceMoveAck.requestId` uses `WORKSPACE_REQUEST_PATTERN`.
- append the new models to the `ClientMessage` union.

- [ ] **Step 8: Run tests and linters**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces.py tests/test_api.py -q`
Expected: PASS.
Run: `..\.venv\Scripts\python.exe -m ruff check .`
Expected: clean.

- [ ] **Step 9: Commit (only if git exists)**

```bash
git add backend/app/services/workspaces.py backend/app/config.py backend/app/models/schemas.py backend/tests/test_workspaces.py backend/tests/test_api.py .env.example
git commit -m "feat: add workspace primitives and protocol schemas"
```

---

### Task 2: SQLite workspace persistence and legacy migration

**Files:**
- Modify: `backend/app/services/storage.py`
- Modify: `backend/tests/test_storage.py`

**Interfaces:**
- Consumes: workspace dicts from Task 1.
- Produces:
  - `Snapshot.workspaces: list[dict[str, Any]]`
  - `SnapshotStore.save(room_id: str, objects: list[dict], seq: int, workspaces: list[dict]) -> None`
  - SQLite column `room_snapshots.workspaces`

- [ ] **Step 1: Update existing tests and add failing workspace tests**

Change every `store.save(...)` call in `backend/tests/test_storage.py` to pass a fourth argument `[]`, and assert `snapshot.workspaces == []` in the basic roundtrip.

Add:

```python
import sqlite3

from app.services.workspaces import default_workspace


async def test_snapshot_roundtrip_preserves_workspaces(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    workspaces = [
        {"id": "ws_default", "name": "Страница 1", "position": 0},
        {"id": "ws_extra", "name": "Черновик", "position": 1},
    ]
    await store.save("room-1", [{"id": "o1", "workspaceId": "ws_extra"}], 7, workspaces)
    snapshot = await store.load("room-1")
    assert snapshot is not None
    assert snapshot.workspaces == workspaces
    assert snapshot.objects[0]["workspaceId"] == "ws_extra"


async def test_legacy_database_is_migrated(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE room_snapshots (room_id TEXT PRIMARY KEY, objects TEXT NOT NULL, "
        "seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO room_snapshots VALUES ('old', '[{\"id\": \"o1\"}]', 3, '2026-01-01T00:00:00+00:00')"
    )
    conn.commit()
    conn.close()

    store = SnapshotStore(path)
    snapshot = await store.load("old")
    assert snapshot is not None
    assert snapshot.objects == [{"id": "o1"}]
    assert snapshot.workspaces == []
    assert snapshot.seq == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_storage.py -q`
Expected: FAIL because `save` takes three arguments and `Snapshot` has no `workspaces`.

- [ ] **Step 3: Implement migration and persistence**

- Add `workspaces: list[dict[str, Any]]` to `Snapshot` (with `objects`, `seq`, `updated_at`).
- Add `workspaces TEXT NOT NULL DEFAULT '[]'` to `_SCHEMA`.
- Add `_migrate(conn)` called in `_init_db`: read `PRAGMA table_info(room_snapshots)`; if `workspaces` is absent, run `ALTER TABLE room_snapshots ADD COLUMN workspaces TEXT NOT NULL DEFAULT '[]'`.
- `save` serializes `workspaces` with `json.dumps(..., separators=(",", ":"))`, stores it in the INSERT/UPDATE, and accepts the new argument.
- `_load_sync` parses `workspaces`; malformed/non-list data becomes `[]`, matching the existing object-parsing behavior.
- Keep `delete_older_than` unchanged.

- [ ] **Step 4: Run storage tests**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_storage.py -q`
Expected: PASS (including the legacy migration test).

- [ ] **Step 5: Commit (only if git exists)**

```bash
git add backend/app/services/storage.py backend/tests/test_storage.py
git commit -m "feat: persist workspaces in SQLite snapshots"
```

---

### Task 3: Room model, workspace CRUD, object scoping, and state switching

**Files:**
- Modify: `backend/app/services/room_manager.py`
- Modify: `backend/tests/test_room_manager.py`

**Interfaces:**
- Consumes: workspace primitives and `Snapshot.workspaces`.
- Produces:
  - `Room.workspaces: dict[str, dict]`, `Room.workspace_list() -> list[dict]`, `Room.workspace_ids() -> list[str]`, `Room.get_workspace(id) -> dict | None`, `Room.add_workspace(name) -> dict`, `Room.rename_workspace(id, name) -> dict | None`, `Room.delete_workspace(id) -> tuple[dict | None, str | None]`, `Room.reorder_workspaces(ids) -> bool`, `Room.objects_in(id) -> list[dict]`, `Room.clear_workspace(id) -> None`
  - `ConnectedUser.workspace_id: str`, `ConnectedUser.state_version: int`
  - `RoomManager.create_workspace(room, name=None) -> dict`
  - `RoomManager.rename_workspace(room, id, name) -> dict | None`
  - `RoomManager.delete_workspace(room, id) -> tuple[dict | None, str | None]`
  - `RoomManager.reorder_workspaces(room, ids) -> bool`
  - `RoomManager.add_object(room, obj, workspace_id) -> dict`
  - `RoomManager.clear_room(room, workspace_id) -> None`
  - `RoomManager.objects_for(room, workspace_id) -> list[dict]`
  - `RoomManager.switch_workspace(room, user, workspace_id, *, reason="switch", by=None) -> bool`
  - `RoomManager.broadcast(..., workspace_id: str | None = None)`
  - `RoomManager.move_users_from_deleted(room, deleted_id, fallback_id) -> None`

- [ ] **Step 1: Write failing room/manager tests**

Add to `backend/tests/test_room_manager.py`:

```python
def set_workspace(user: ConnectedUser, workspace_id: str) -> None:
    user.workspace_id = workspace_id


async def test_new_room_has_default_workspace(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    assert room.workspace_ids() == ["ws_default"]
    assert room.workspace_list()[0]["name"] == "Страница 1"
    await manager.shutdown()
    await store.close()


async def test_workspace_crud_and_positions(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Черновик")
    assert room.workspace_ids() == ["ws_default", second["id"]]
    assert manager.rename_workspace(room, second["id"], "Идеи")["name"] == "Идеи"
    assert manager.reorder_workspaces(room, [second["id"], "ws_default"]) is True
    assert room.workspace_ids() == [second["id"], "ws_default"]
    assert manager.reorder_workspaces(room, ["ws_default"]) is False
    deleted, fallback = manager.delete_workspace(room, second["id"])
    assert deleted["id"] == second["id"]
    assert fallback == "ws_default"
    assert manager.delete_workspace(room, "ws_default") == (None, None)
    await manager.shutdown()
    await store.close()


async def test_objects_and_clear_are_scoped(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")
    manager.add_object(room, {**SAMPLE_OBJECT, "id": "o2"}, second["id"])
    assert [obj["id"] for obj in room.objects_in("ws_default")] == ["o1"]
    assert [obj["id"] for obj in room.objects_in(second["id"])] == ["o2"]
    manager.clear_room(room, second["id"])
    assert [obj["id"] for obj in room.objects] == ["o1"]
    await manager.shutdown()
    await store.close()


async def test_broadcast_filters_by_workspace(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    first_user, first_socket = make_user("a", role="student")
    second_user, second_socket = make_user("b", role="student")
    first_user.workspace_id = "ws_default"
    second_user.workspace_id = second["id"]
    await manager.join("r1", first_user)
    await manager.join("r1", second_user)
    await manager.broadcast(room, {"type": "shape_add", "workspaceId": "ws_default"})
    assert [m["type"] for m in first_socket.messages] == ["shape_add"]
    assert second_socket.messages == []
    await manager.shutdown()
    await store.close()


async def test_switch_sends_state_and_finalizes_stroke(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    user, socket = make_user("a", role="student")
    await manager.join("r1", user)
    socket.messages.clear()
    user.strokes["s1"] = {
        "id": "s1",
        "type": "stroke",
        "author": "a",
        "workspaceId": "ws_default",
        "points": [[1, 2], [3, 4]],
        "tool": "brush",
        "color": "#123456",
        "width": 4,
    }
    assert await manager.switch_workspace(room, user, second["id"]) is True
    assert user.workspace_id == second["id"]
    assert [obj["id"] for obj in room.objects_in("ws_default")] == ["s1"]
    assert socket.messages[0]["type"] == "cursor_remove"
    assert socket.messages[-1]["type"] == "workspace_state"
    assert socket.messages[-1]["stateVersion"] == 1
    assert user.strokes == {}
    await manager.shutdown()
    await store.close()


async def test_delete_discards_active_strokes_on_that_page(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    user, _ = make_user("a", role="student")
    await manager.join("r1", user)
    user.workspace_id = second["id"]
    user.strokes["s1"] = {
        "id": "s1",
        "type": "stroke",
        "author": "a",
        "workspaceId": second["id"],
        "points": [[1, 2]],
        "tool": "brush",
        "color": "#123456",
        "width": 4,
    }
    assert manager.delete_workspace(room, second["id"])[1] == "ws_default"
    assert user.strokes == {}
    assert room.objects == []
    await manager.shutdown()
    await store.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_room_manager.py -q`
Expected: FAIL on missing methods/signatures.

- [ ] **Step 3: Implement room metadata and CRUD**

Use `normalize_workspaces`, `default_workspace`, `next_workspace_name`, and `assign_orphan_objects` from Task 1.

In `Room.__init__`, initialize `self.workspaces` from `normalize_workspaces(None)`; when a snapshot is restored, `RoomManager` passes `normalize_workspaces(snapshot.workspaces)` and repairs objects.

Implement `workspace_list()` as a position-sorted copy. `add_workspace` appends at `len`, `rename_workspace` updates a copy, `delete_workspace` removes metadata and objects for that id and returns `(deleted, first_remaining_id_or_None)`, `reorder_workspaces` validates the exact id set then reassigns positions, `objects_in` filters, `clear_workspace` removes only matching objects and index entries.

Before removing objects in `delete_workspace`, drop active strokes on that page: iterate `room.users`, remove entries from `user.strokes` whose `workspaceId == workspace_id`, so a later `switch_workspace` cannot finalize them into a deleted page.

- [ ] **Step 4: Implement manager scoping and switching**

- Change `add_object` to set `obj["workspaceId"] = workspace_id` and call `room.add_object`.
- Change `clear_room(room, workspace_id)` to call `room.clear_workspace`.
- Add `objects_for(room, workspace_id)`.
- Extend `broadcast`/`_send_local` with `workspace_id`; when set, skip users whose `user.workspace_id` differs. When receiving a message, callers pass `message.get("workspaceId")`.
- `_finalize_strokes` calls `self.add_object(room, obj, obj["workspaceId"])` (falling back to the room's first workspace if an old stroke lacks it) and broadcasts with the stroke's `workspaceId`.
- `switch_workspace`:
  1. Return `False` if the workspace does not exist.
  2. Under `user.workspace_lock`, if `user.workspace_id == workspace_id` still send a fresh state (version increments).
  3. Finalize strokes on the old page, broadcast `cursor_remove` to the old page.
  4. Set `user.workspace_id`, increment `state_version`.
  5. Send `workspace_moved` when `reason == "pull"` (include `by`), then `workspace_state` with `workspaceId`, `objects`, `stateVersion`.
- `delete_workspace` removes state and marks dirty; the WS layer broadcasts `workspace_deleted` and then calls `move_users_from_deleted`.
- `move_users_from_deleted` calls `switch_workspace` for every user whose workspace is the deleted id, with `reason="delete"`.
- Save `snapshot.workspaces` from `room.workspace_list()` in `save_room`; restore on `get_or_create` and call `assign_orphan_objects`.

- [ ] **Step 5: Update existing manager tests for new signatures**

Change existing `manager.add_object(room, ...)` calls to pass a workspace id, and `manager.clear_room(room)` to pass the current workspace. Keep assertions about objects.

- [ ] **Step 6: Run manager tests**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_room_manager.py tests/test_storage.py -q`
Expected: PASS.

- [ ] **Step 7: Commit (only if git exists)**

```bash
git add backend/app/services/room_manager.py backend/tests/test_room_manager.py
git commit -m "feat: add workspace state to rooms"
```

---

### Task 4: Two-phase pull, ack, timeout, and user state versioning

**Files:**
- Modify: `backend/app/services/room_manager.py`
- Test: `backend/tests/test_room_manager.py`

**Interfaces:**
- Consumes: `switch_workspace`, `ConnectedUser`.
- Produces:
  - `@dataclass PendingMove(request_id: str, workspace_id: str, by: str | None, task: asyncio.Task | None)`
  - `ConnectedUser.pending_move: PendingMove | None`
  - `RoomManager.prepare_move(room, user, workspace_id, by) -> str`
  - `RoomManager.handle_move_ack(room, user, request_id) -> bool`
  - `RoomManager.pull_users(room, teacher, *, client_ids: list[str], all: bool) -> int`

- [ ] **Step 1: Write failing tests**

Add:

```python
async def test_pull_prepares_then_moves_on_ack(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    teacher, _ = make_user("t", role="teacher")
    student, socket = make_user("s", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)
    teacher.workspace_id = second["id"]
    socket.messages.clear()

    assert await manager.pull_users(room, teacher, client_ids=["s"], all=False) == 1
    prepare = socket.messages[-1]
    assert prepare["type"] == "workspace_prepare_move"
    assert prepare["workspaceId"] == second["id"]
    assert student.workspace_id == "ws_default"
    assert await manager.handle_move_ack(room, student, prepare["requestId"]) is True
    assert student.workspace_id == second["id"]
    assert [m["type"] for m in socket.messages[-2:]] == ["workspace_moved", "workspace_state"]


async def test_pull_all_moves_only_students(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    teacher, teacher_socket = make_user("t", role="teacher")
    first, first_socket = make_user("s1", role="student")
    second_user, second_socket = make_user("s2", role="student")
    for user in (teacher, first, second_user):
        await manager.join("r1", user)
    teacher.workspace_id = second["id"]
    first_socket.messages.clear()
    second_socket.messages.clear()
    teacher_socket.messages.clear()

    assert await manager.pull_users(room, teacher, client_ids=[], all=True) == 2
    assert teacher.workspace_id == second["id"]
    assert first.workspace_id == "ws_default"
    assert second_user.workspace_id == "ws_default"
    for socket in (first_socket, second_socket):
        request = socket.messages[-1]
        await manager.handle_move_ack(room, first if socket is first_socket else second_user, request["requestId"])
    assert first.workspace_id == second["id"]
    assert second_user.workspace_id == second["id"]
    assert teacher_socket.messages == []


async def test_pull_timeout_moves_without_ack(tmp_path: Path) -> None:
    settings, store, manager = build_manager(tmp_path)
    settings = settings.model_copy(update={"workspace_move_timeout_seconds": 0.05})
    manager.settings = settings
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    teacher, _ = make_user("t", role="teacher")
    student, socket = make_user("s", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)
    teacher.workspace_id = second["id"]
    socket.messages.clear()
    await manager.pull_users(room, teacher, client_ids=["s"], all=False)
    prepare = socket.messages[-1]
    await asyncio.sleep(0.12)
    assert student.workspace_id == second["id"]
    assert socket.messages[-1]["type"] == "workspace_state"
    assert await manager.handle_move_ack(room, student, prepare["requestId"]) is False


async def test_stale_ack_is_ignored(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    teacher, _ = make_user("t", role="teacher")
    student, socket = make_user("s", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)
    teacher.workspace_id = second["id"]
    socket.messages.clear()
    await manager.pull_users(room, teacher, client_ids=["s"], all=False)
    prepare = socket.messages[-1]
    assert await manager.handle_move_ack(room, student, "mv_wrong") is False
    assert student.workspace_id == "ws_default"
    assert await manager.handle_move_ack(room, student, prepare["requestId"]) is True


async def test_manual_switch_does_not_cancel_pending_pull(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    teacher, _ = make_user("t", role="teacher")
    student, socket = make_user("s", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)
    teacher.workspace_id = second["id"]
    socket.messages.clear()
    await manager.pull_users(room, teacher, client_ids=["s"], all=False)
    prepare = socket.messages[-1]
    assert await manager.switch_workspace(room, student, "ws_default") is True
    assert await manager.handle_move_ack(room, student, prepare["requestId"]) is True
    assert student.workspace_id == second["id"]
    assert socket.messages[-1]["stateVersion"] == 2
```

- [ ] **Step 2: Run to verify failure**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_room_manager.py -q`
Expected: FAIL with missing `pull_users`.

- [ ] **Step 3: Implement prepare/ack/timeout**

- Add `PendingMove` and `ConnectedUser.pending_move`, `ConnectedUser.workspace_lock`.
- `prepare_move` cancels any previous pending task, creates `mv_<uuidhex>`, sends `{"type": "workspace_prepare_move", "requestId", "workspaceId", "name", "by"}`, and starts `asyncio.create_task(self._move_timeout(room, user, request_id))`.
- `_move_timeout` sleeps `settings.workspace_move_timeout_seconds`, then calls `_complete_move` if the pending request still matches.
- `handle_move_ack` returns `False` if there is no matching pending move; otherwise cancels the timeout and completes the move.
- `_complete_move` clears `pending_move`, then calls `switch_workspace(..., reason="pull", by=pending.by)`.
- `pull_users` selects targets from `room.users` (role `student`, ids valid, not the teacher) when `all` or `client_ids` is given, calls `prepare_move` for each, and returns the count. Return `0` when no valid targets.
- On `leave`, cancel and clear any pending move.

- [ ] **Step 4: Run tests**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_room_manager.py -q`
Expected: PASS.

- [ ] **Step 5: Commit (only if git exists)**

```bash
git add backend/app/services/room_manager.py backend/tests/test_room_manager.py
git commit -m "feat: add two-phase teacher pull"
```

---

### Task 5: Redis workspace state, authority rules, and remote pull

**Files:**
- Modify: `backend/app/services/room_manager.py`
- Modify: `backend/tests/test_redis.py`

**Interfaces:**
- Consumes: room/manager workspace APIs from Tasks 3–4.
- Produces:
  - `RoomManager._workspaces_key(room_id) -> str`
  - `RoomManager._restore_redis_state(room) -> bool` (True = Redis authoritative)
  - `RoomManager._seed_redis_state(room) -> None`
  - Workspace events handled by `_sync_redis_event` / `_apply_remote_event`
  - `pull_users` publishes remote prepares.

- [ ] **Step 1: Write failing Redis tests**

Add to `backend/tests/test_redis.py`:

```python
async def test_empty_redis_is_seeded_from_snapshot(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    await manager_a.startup()
    room = await manager_a.get_or_create("shared")
    extra = manager_a.create_workspace(room, "Вторая")
    await manager_a.broadcast(room, {"type": "workspace_created", "workspace": extra})
    manager_a.add_object(room, {"id": "o1", "type": "shape"}, extra["id"])
    await manager_a.broadcast(
        room, {"type": "shape_add", "workspaceId": extra["id"], "object": room.get_object("o1")}
    )
    await wait_for_hash_field(first_redis, "whiteboard:room:shared:workspaces", extra["id"])

    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_b.startup()
    room_b = await manager_b.get_or_create("shared")
    assert room_b.workspace_ids() == ["ws_default", extra["id"]]
    assert room_b.get_object("o1")["workspaceId"] == extra["id"]
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_redis_workspaces_beat_stale_sqlite(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    store = SnapshotStore(tmp_path / "snap.db")
    await store.save(
        "shared",
        [{"id": "old", "workspaceId": "ws_default"}],
        1,
        [{"id": "ws_default", "name": "Старая", "position": 0}],
    )
    manager_a = RoomManager(settings, store, redis_client=first_redis)
    await manager_a.startup()
    room_a = await manager_a.get_or_create("shared")
    manager_a.rename_workspace(room_a, "ws_default", "Живая")
    await manager_a.broadcast(
        room_a,
        {
            "type": "workspace_renamed",
            "workspaceId": "ws_default",
            "name": "Живая",
        },
    )
    extra = manager_a.create_workspace(room_a, "Новая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})

    manager_b = RoomManager(settings, store, redis_client=second_redis)
    await manager_b.startup()
    room_b = await manager_b.get_or_create("shared")
    assert room_b.workspace_ids() == ["ws_default", extra["id"]]
    assert room_b.workspace_list()[0]["name"] == "Живая"
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_remote_pull_prepares_on_owner_instance(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()
    teacher, _ = make_user("t", "teacher")
    student, socket_b = make_user("s")
    room_a = await manager_a.join("lesson", teacher)
    room_b = await manager_b.join("lesson", student)
    extra = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})
    await wait_for_hash_field(first_redis, "whiteboard:room:lesson:workspaces", extra["id"])
    teacher.workspace_id = extra["id"]
    socket_b.messages.clear()

    assert await manager_a.pull_users(room_a, teacher, client_ids=["s"], all=False) == 1
    await wait_for(lambda: any(m["type"] == "workspace_prepare_move" for m in socket_b.messages))
    prepare = next(m for m in socket_b.messages if m["type"] == "workspace_prepare_move")
    await manager_b.handle_move_ack(room_b, student, prepare["requestId"])
    assert student.workspace_id == extra["id"]
    await manager_a.shutdown()
    await manager_b.shutdown()
```

- [ ] **Step 2: Run to verify failure**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_redis.py -q`
Expected: FAIL because workspace keys and events are not implemented.

Before implementing, update the existing `test_redis.py` calls: every `manager.add_object(...)` passes the workspace id (use `"ws_default"`), and every broadcast object dict includes `"workspaceId": "ws_default"` so scoped filtering and Redis sync exercise the new path.

- [ ] **Step 3: Implement Redis workspace state**

- Add `_workspaces_key(room_id)` = `<prefix>:room:<id>:workspaces`.
- In `get_or_create`, after loading SQLite and normalizing workspaces, call `_restore_redis_state`; if it returns `False`, call `_seed_redis_state`.
- `_restore_redis_state` returns `False` when `workspaces`, `objects`, and `seq` are all absent. Otherwise it is authoritative: load metadata, objects, seq; normalize; repair orphan objects; write repaired metadata/objects back.
- `_seed_redis_state` writes the workspaces hash, objects hash, and seq in one startup path (loop `hset` or pipeline).
- Extend `_sync_redis_event`:
  - `workspace_created/renamed/reordered` → hset metadata.
  - `workspace_deleted` → hdel metadata; scan the objects hash and delete fields whose value has that `workspaceId`.
  - object events → hset with `workspaceId`; `object_delete` → hdel; `clear` → delete only objects of the event's workspace.
- Extend `_apply_remote_event` for the same workspace events; on `workspace_deleted`, remove objects and call `move_users_from_deleted` for local users.
- `_listen` must treat `remote_workspace_pull` specially: call `prepare_move` for local matching students. The event carries `workspaceId`, `by`, and either `all: true` or `clientIds`.
- `pull_users`: use `await list_users(room)` to include remote presence. Local students get `prepare_move`; remote ids go into a published `remote_workspace_pull` event (`clientIds` or `all`). Return the count of valid merged targets; `0` means the WS layer sends `user_not_found`.

- [ ] **Step 4: Run Redis tests**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_redis.py -q`
Expected: PASS.

- [ ] **Step 5: Commit (only if git exists)**

```bash
git add backend/app/services/room_manager.py backend/tests/test_redis.py
git commit -m "feat: share workspaces through Redis"
```

---

### Task 6: WebSocket protocol, handlers, and init

**Files:**
- Modify: `backend/app/api/ws.py`
- Modify: `backend/tests/test_ws.py`
- Test: `backend/tests/test_workspaces_ws.py`

**Interfaces:**
- Consumes: manager APIs from Tasks 3–5, schemas from Task 1.
- Produces: all workspace messages/events from the spec; `init` with `workspaces`, `workspaceId`; `workspace` query parameter.

- [ ] **Step 1: Write failing WebSocket tests**

Create `backend/tests/test_workspaces_ws.py` with a helper that connects and returns `(websocket, init)`. Use `login_user` and `ws_url`.

Tests and assertions:

1. `test_init_has_workspaces_and_current_page`: teacher init has one workspace with id `ws_default`, `workspaceId == "ws_default"`, and `permissions["canManageWorkspaces"] is True`; student `False`.
2. `test_switch_is_per_user`: student sends `workspace_switch` to a newly created page; student receives `workspace_state`, teacher receives no state and stays on `ws_default`.
3. `test_student_cannot_manage_workspaces`: student sends `workspace_create`; receives `error` with `code == "forbidden"`.
4. `test_teacher_creates_page_and_creator_switches`: teacher sends `workspace_create`; both receive `workspace_created`; teacher also receives `workspace_state` for the new id; student stays.
5. `test_objects_are_isolated_between_pages`: teacher creates page 2; student stays on page 1; teacher switches to page 2 and sends `shape_add` with `workspaceId` of page 2; student receives nothing; a late student on page 2 receives the object in `init`.
6. `test_clear_only_current_page`: objects on pages 1 and 2; teacher clears page 2; page 1 object remains.
7. `test_delete_last_workspace_is_rejected`: teacher sends delete for `ws_default`; error `last_workspace`.
8. `test_delete_workspace_moves_viewers_to_fallback`: teacher and student on page 2; teacher deletes page 2; both get `workspace_deleted` with `fallbackId == "ws_default"` and `workspace_state`.
9. `test_rename_and_reorder_broadcast`: both clients receive `workspace_renamed` and `workspace_reordered` with matching ids.
10. `test_pull_single_student_two_phase`: teacher on page 2 pulls student; student gets `workspace_prepare_move`, no move yet; student sends `workspace_move_ack`; then `workspace_moved` + `workspace_state`; teacher unaffected.
11. `test_pull_all_students`: two students; teacher pulls all; both move; teacher stays.
12. `test_stale_workspace_object_rejected`: send `shape_add` with old `workspaceId` after switching; receive `error` `stale_workspace`; object not in room.
13. `test_workspace_query_param_restores_page`: connect with `?workspace=<id>`; init `workspaceId` matches.

Update `backend/tests/test_ws.py` exact-dict assertions to include `workspaceId` in object events (for example the `stroke_point` dict and `user_joined` remains unchanged), and assert the new init fields.

- [ ] **Step 2: Run to verify failure**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_workspaces_ws.py -q`
Expected: FAIL with unknown `workspace_switch`/missing init fields.

- [ ] **Step 3: Implement init and query parameter**

- Add `workspace: str = Query(default="")` to `websocket_endpoint`.
- After `join`, choose `user.workspace_id`: requested id if it exists, otherwise `room.workspace_ids()[0]`.
- Build `init` with `workspaces`, `workspaceId`, and `objects = manager.objects_for(room, user.workspace_id)`.
- Include `permissions_for(user.role).model_dump()` (now with `canManageWorkspaces`).

- [ ] **Step 4: Implement message dispatch and handlers**

- Extend `_handle_message` with the new model types.
- Add helper `_check_workspace(user, message) -> bool`: if `message.workspaceId` is set and differs from `user.workspace_id`, send `stale_workspace` and return `False`.
- Use it at the start of every object/cursor/clear handler.
- Stamp objects with `workspaceId=user.workspace_id` in `_new_object` (add the argument or set it after).
- Add `workspaceId` to every object/cursor/clear broadcast dict.
- `broadcast(..., workspace_id=...)` for object events; room-level events use no filter.
- `_handle_workspace_switch`: `switch_workspace`, on failure `workspace_not_found`.
- `_handle_workspace_create`: teacher check, limit check using `len(room.workspaces) >= settings.max_workspaces_per_room` (`workspace_limit`), `manager.create_workspace`, broadcast `workspace_created`, then `switch_workspace(..., reason="create")`.
- `_handle_workspace_rename`: teacher check, name strip, `invalid_message` on empty/too long, broadcast.
- `_handle_workspace_reorder`: teacher check, `manager.reorder_workspaces`; `invalid_message` on false; broadcast.
- `_handle_workspace_delete`: teacher check, `manager.delete_workspace`; `last_workspace` if none; broadcast `workspace_deleted` with `fallbackId`, then `move_users_from_deleted`.
- `_handle_workspace_pull`: teacher check; validate `all` vs `clientIds` already in schema; call `manager.pull_users`; `user_not_found` if 0.
- `_handle_workspace_move_ack`: call `manager.handle_move_ack`; ignore stale.
- `_receive_loop` dispatches `workspace_move_ack` like other messages.
- `clear` handler uses `manager.clear_room(room, user.workspace_id)` and broadcasts `workspaceId`.
- `cursor` handler broadcasts with `workspaceId`.
- `switch_workspace` already sends `cursor_remove` and state; ensure `workspace_state` includes objects of the target page.

- [ ] **Step 5: Run WebSocket tests**

Run: `..\.venv\Scripts\python.exe -m pytest tests/test_ws.py tests/test_workspaces_ws.py -q`
Expected: PASS.

- [ ] **Step 6: Commit (only if git exists)**

```bash
git add backend/app/api/ws.py backend/tests/test_ws.py backend/tests/test_workspaces_ws.py
git commit -m "feat: expose workspaces over WebSocket"
```

---

### Task 7: Frontend pages panel, per-user switching, buffering, session restore

**Files:**
- Create: `frontend/js/pages.js`
- Modify: `frontend/index.html`
- Modify: `frontend/css/style.css`
- Modify: `frontend/js/main.js`
- Modify: `frontend/js/sync.js`
- Modify: `frontend/js/board.js`
- Test: `e2e/tests/workspaces.spec.js`
- Test: `e2e/helpers.js`
- Test: `e2e/tests/mobile.spec.js`

**Interfaces:**
- Consumes: `init.workspaces`, `init.workspaceId`, `workspace_*` events.
- Produces:
  - `PagesPanel` class with `constructor({container, onSelect, onCreate, onRename, onDelete, onMove})` and `render(workspaces, activeId, {canManage, busy})`
  - `SyncClient` accepts optional `workspaceId` and appends `&workspace=...`
  - `Board.setInteractive(enabled: boolean)`
  - `state.workspaces`, `state.workspaceId`, `state.pendingWorkspaceId`, `state.pendingEvents`, `state.stateVersion`
  - session field `workspaceId`

- [ ] **Step 1: Write the failing E2E test**

Create `e2e/tests/workspaces.spec.js`:

```js
import { expect, test } from '@playwright/test';

import {
  activePageName,
  createPage,
  drawRect,
  login,
  movePage,
  objectCount,
  pageNames,
  reloadAndWait,
  renamePage,
  selectPage,
  uniqueRoom,
} from '../helpers.js';

test('workspaces: create, isolate, switch, rename, reorder, reload', async ({ browser }) => {
  const room = uniqueRoom('ws');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  expect(await pageNames(student)).toEqual(['Страница 1']);
  await createPage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Вторая']);
  expect(await activePageName(teacher)).toBe('Вторая');

  await drawRect(teacher, { x: 300, y: 300 }, { x: 420, y: 390 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
  expect(await objectCount(student)).toBe(0);

  await selectPage(student, 'Вторая');
  await expect.poll(() => objectCount(student)).toBe(1);

  await renamePage(teacher, 'Вторая', 'Черновик');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Черновик']);

  await movePage(teacher, 'Черновик', 'up');
  await expect.poll(() => pageNames(student)).toEqual(['Черновик', 'Страница 1']);

  await reloadAndWait(student);
  await expect.poll(() => pageNames(student)).toEqual(['Черновик', 'Страница 1']);
  expect(await activePageName(student)).toBe('Черновик');

  await teacherContext.close();
  await studentContext.close();
});
```

Add helpers to `e2e/helpers.js`:

```js
export async function pageNames(page) {
  return page.locator('#pages-panel .page__name').allTextContents();
}

export async function activePageName(page) {
  return page.locator('#pages-panel .page.is-active .page__name').textContent();
}

export async function selectPage(page, name) {
  await page.locator('#pages-panel .page', { hasText: name }).locator('.page__select').click();
}

export async function createPage(page, name) {
  page.once('dialog', async (dialog) => {
    await dialog.accept(name);
  });
  await page.click('#page-add');
}

export async function renamePage(page, oldName, newName) {
  page.once('dialog', async (dialog) => {
    await dialog.accept(newName);
  });
  await page.locator('#pages-panel .page', { hasText: oldName }).locator('.page__rename').click();
}

export async function movePage(page, name, direction) {
  const selector = direction === 'up' ? '.page__up' : '.page__down';
  await page.locator('#pages-panel .page', { hasText: name }).locator(selector).click();
}
```

- [ ] **Step 2: Run to verify failure**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/workspaces.spec.js`
Expected: FAIL because `#pages-panel` does not exist.

- [ ] **Step 3: Add the pages panel module and markup**

Create `frontend/js/pages.js`:

```js
export class PagesPanel {
  constructor({ container, onSelect, onCreate, onRename, onDelete, onMove }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onMove = onMove;
  }

  render(workspaces, activeId, { canManage = false, busy = false } = {}) {
    // Rebuild children. Header contains title, "+ Страница" button (id="page-add").
    // Each item uses .page, .page__select, .page__name, .page__rename,
    // .page__delete, .page__up, .page__down; active item gets .is-active.
    // Teacher-only controls are omitted for students; all buttons are disabled
    // while busy is true.
  }
}
```

In `index.html`, add inside `.workspace`, before `#board`:

```html
<aside id="pages-panel" class="pages-panel" aria-label="Страницы"></aside>
```

The create/rename flow uses `window.prompt` with the current/default name; cancel aborts the action and an empty string is ignored. No extra input element is needed.

- [ ] **Step 4: Add layout CSS**

Desktop: `.workspace` stays flex; `.pages-panel` is `width: 210px; border-right; overflow-y: auto; padding: 12px; background: var(--panel)`. Page rows are flex with a select button and actions; `.page.is-active` uses the accent background. At `max-width: 900px`, switch `.workspace` to `flex-direction: column`, make `.pages-panel` a horizontal strip with `overflow-x: auto`, and keep `#board` `flex: 1; min-height: 0`.

- [ ] **Step 5: Implement client state and switching**

In `main.js`:
- import `PagesPanel`; cache `#pages-panel`.
- extend `state` with the fields in Interfaces.
- add `function sendWorkspace(message)` that returns `state.sync?.send({ ...message, workspaceId: state.workspaceId })`; use it for every object/cursor/clear send in `main.js` and as the `onEvent` callback for `ToolManager`. Do not add `workspaceId` to workspace management messages (`workspace_switch`, `workspace_create`, etc.).
- create `pagesPanel` in `startSession` after the board, with callbacks:
  - `onSelect(id)` → `requestWorkspaceSwitch(id)`
  - `onCreate()` → `requestWorkspaceCreate()`
  - `onRename(ws)` → prompt/input, then send `workspace_rename`
  - `onDelete(ws)` → `confirm`, then send `workspace_delete`
  - `onMove(id, direction)` → compute the reordered id list and send `workspace_reorder`
- `requestWorkspaceSwitch(id)` commits text, calls `state.board.setInteractive(false)`, sets `pendingWorkspaceId`, clears `pendingEvents`, sends `workspace_switch`.
- `handleInit`: set workspaces/workspaceId, render pages, save session with `workspaceId`.
- `handleServerEvent`: route object/cursor events through `applyWorkspaceEvent(message)`:
  - ignore events whose `workspaceId` is neither current nor pending;
  - buffer pending events;
  - after `workspace_state` (higher `stateVersion`) set objects, clear cursors/selection, set ids, replay buffered events, re-enable input, render.
- Handle `workspace_created`, `workspace_renamed`, `workspace_reordered`, `workspace_deleted`, `cursor_remove`.
- `workspace_state` for a deleted/created page also sets `pendingWorkspaceId`; accept any newer `stateVersion`.
- Save `workspaceId` in the stored session on every state change.
- `SyncClient` constructor receives `workspaceId`; `startSession` passes `session.workspaceId`; `connect()` appends `&workspace=...` when non-empty.
- Add `Board.setInteractive(enabled)` → `this.stage.listening(enabled)`.
- On `leaveLesson`, clear workspace state and destroy pages panel.

- [ ] **Step 6: Run the workspace E2E test**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/workspaces.spec.js`
Expected: PASS.

- [ ] **Step 7: Add a mobile assertion**

In `e2e/tests/mobile.spec.js`, after login assert `#pages-panel` is visible and the first page is active; create a page and switch back, asserting the active name changes.

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/mobile.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit (only if git exists)**

```bash
git add frontend/js/pages.js frontend/index.html frontend/css/style.css frontend/js/main.js frontend/js/sync.js frontend/js/board.js e2e/tests/workspaces.spec.js e2e/tests/mobile.spec.js e2e/helpers.js
git commit -m "feat: add workspace pages panel"
```

---

### Task 8: Pull UI, prepare/ack, and draft preservation

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/css/style.css`
- Modify: `frontend/js/main.js`
- Modify: `frontend/js/tools.js`
- Test: `e2e/tests/workspaces.spec.js`
- Test: `e2e/helpers.js`

**Interfaces:**
- Consumes: `workspace_prepare_move`, `workspace_move_ack`, `workspace_moved`, pull permissions.
- Produces:
  - `state.selectedStudentIds: Set<string>`, `state.moveRequestId`
  - `ToolManager.finishActiveStroke(): void`
  - Users panel checkboxes and `#pull-selected` / `#pull-all`
  - E2E helpers `selectStudent`, `pullSelected`, `pullAll`

- [ ] **Step 1: Write failing E2E tests**

Append to `e2e/tests/workspaces.spec.js`:

```js
test('pull one and all students to the teacher page', async ({ browser }) => {
  const room = uniqueRoom('pull');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  const second = await secondContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Первый', role: 'student', room });
  await login(second, { name: 'Второй', role: 'student', room });

  await createPage(teacher, 'Вторая');
  await selectStudent(teacher, 'Первый');
  await pullSelected(teacher);
  await expect.poll(() => activePageName(student)).toBe('Вторая');
  expect(await activePageName(second)).toBe('Страница 1');

  await pullAll(teacher);
  await expect.poll(() => activePageName(second)).toBe('Вторая');
  await expect.poll(() => activePageName(teacher)).toBe('Вторая');

  await teacherContext.close();
  await studentContext.close();
  await secondContext.close();
});

test('pull preserves a text draft on the old page', async ({ browser }) => {
  const room = uniqueRoom('draft');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  await createPage(teacher, 'Вторая');
  await student.click('[data-tool="text"]');
  const point = await worldToScreen(student, { x: 500, y: 400 });
  await student.mouse.click(point.x, point.y);
  await student.fill('#text-editor', 'Черновик');
  await expect(student.locator('#text-editor')).toBeVisible();

  await pullAll(teacher);
  await expect.poll(() => activePageName(student)).toBe('Вторая');
  await expect(student.locator('#text-editor')).toBeHidden();

  await selectPage(teacher, 'Страница 1');
  await expect
    .poll(() =>
      teacher.evaluate(() =>
        window.Konva.stages[0]
          .getLayers()[1]
          .getChildren((node) => Boolean(node.id()))
          .some((node) => node.findOne('Text')?.text() === 'Черновик'),
      ),
    )
    .toBe(true);

  await teacherContext.close();
  await studentContext.close();
});
```

Add helpers:

```js
export async function selectStudent(page, name) {
  await page
    .locator('#user-list .user', { hasText: name })
    .locator('.user__pull-check')
    .check();
}

export async function pullSelected(page) {
  await page.click('#pull-selected');
}

export async function pullAll(page) {
  await page.click('#pull-all');
}
```

Import `worldToScreen` and `selectPage` in the spec.

- [ ] **Step 2: Run to verify failure**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test tests/workspaces.spec.js`
Expected: FAIL because the pull controls and prepare/ack do not exist.

- [ ] **Step 3: Add pull controls**

In `index.html`, inside the users panel after `#user-list`:

```html
<div id="pull-actions" class="users-panel__pull" hidden>
  <button id="pull-selected" class="btn btn--ghost" type="button">К себе</button>
  <button id="pull-all" class="btn btn--primary" type="button">Всех к себе</button>
</div>
```

CSS: `.users-panel__pull { display: flex; gap: 6px; }`, buttons compact; hidden for students.

`renderUsers` in `main.js`:
- for every user, if `state.user` is teacher, user is a student, and user id differs from self, prepend `<input type="checkbox" class="user__pull-check">` bound to `state.selectedStudentIds`.
- preserve checked ids that still exist; re-render `#pull-actions` disabled state.
- `#pull-selected` sends `workspace_pull` with `clientIds: [...selected]` and clears the set; `#pull-all` sends `{ all: true }`.
- Hide `#pull-actions` when `canManageUsers` is false.

- [ ] **Step 4: Implement prepare/ack on the student client**

In `main.js`:
- Add `case 'workspace_prepare_move'`: set `state.moveRequestId`, block page switching, call `commitText()` (it sends text before returning), call `state.tools.finishActiveStroke()`, then `state.sync.send({ type: 'workspace_move_ack', requestId: message.requestId })`.
- Add `case 'workspace_moved'`: set `pendingWorkspaceId = message.workspaceId`, `ready = false`, board non-interactive, toast `Учитель перенёс вас на страницу «...»`.
- In `handleInit` and `leaveLesson`, reset `moveRequestId`.
- In `workspace_state`, allow applying any state with a newer `stateVersion`; clear `moveRequestId`.

In `tools.js`, add:

```js
finishActiveStroke() {
  this._finishStroke();
  this._cancelShape();
}
```

`_cancelShape()` already exists in `tools.js` and clears the preview; use it directly.

- [ ] **Step 5: Run the E2E suite**

Run: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`
Expected: all workspace, lesson, permissions, reconnect, and mobile tests PASS.

- [ ] **Step 6: Commit (only if git exists)**

```bash
git add frontend/index.html frontend/css/style.css frontend/js/main.js frontend/js/tools.js e2e/tests/workspaces.spec.js e2e/helpers.js
git commit -m "feat: add teacher pull with draft preservation"
```

---

### Task 9: Documentation, plan status, and full regression

**Files:**
- Modify: `README.md`
- Modify: `plan.md`
- Modify: `backend/tests/test_edge_cases.py` (only if regression reveals missing cases)

**Interfaces:**
- Consumes: completed feature.
- Produces: user documentation and a verified full suite.

- [ ] **Step 1: Update README**

Add to features:
- multiple pages per room, per-user switching;
- teacher creates/renames/deletes/reorders pages;
- teacher pulls one/many/all students to their current page.

Update the WebSocket protocol list with `workspace_*` messages and the `workspaceId` field. Update the project structure with `services/workspaces.py`, `frontend/js/pages.js`, and the design/plan docs. Update the test count and E2E scenario list.

- [ ] **Step 2: Update plan.md**

Mark the workspaces iteration complete, add a journal entry with the exact test counts and E2E scenarios, and note the two-phase pull and legacy migration.

- [ ] **Step 3: Run full backend checks**

Run from `backend/`:

```powershell
..\.venv\Scripts\python.exe -m pytest -q
..\.venv\Scripts\python.exe -m ruff check .
..\.venv\Scripts\python.exe -m black --check .
```

Expected: all tests pass, ruff and black clean.

- [ ] **Step 4: Run all E2E tests**

Run from `e2e/`:

```powershell
$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test
```

Expected: all existing plus new workspace scenarios pass.

- [ ] **Step 5: Run the load test smoke check**

Start a local server on a spare port with temporary data directories, then run:

```powershell
.\.venv\Scripts\python.exe scripts\load_test.py --base-url http://127.0.0.1:8125 --clients 6 --duration 3 --interval 0.2
```

Expected: `errors: 0`, no failed clients. Stop the server afterward.

- [ ] **Step 6: Verify compose configs are unchanged**

Run from the project root:

```powershell
docker compose config --quiet
```

Expected: exit code 0 (or skip if Docker is unavailable).

- [ ] **Step 7: Commit (only if git exists)**

```bash
git add README.md plan.md
git commit -m "docs: describe workspaces"
```
