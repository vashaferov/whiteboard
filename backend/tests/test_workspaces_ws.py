"""WebSocket workspace protocol integration tests."""

from __future__ import annotations

import urllib.parse
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi.testclient import TestClient

SHAPE = {
    "type": "shape_add",
    "objectId": "shape-1",
    "shapeType": "rect",
    "x": 10,
    "y": 20,
    "width": 100,
    "height": 60,
    "color": "#2563eb",
    "strokeWidth": 4,
    "fill": None,
}


@contextmanager
def ws_connect(
    client: TestClient, ws_url, token: str, *, workspace: str | None = None
) -> Iterator[tuple]:
    url = ws_url(token)
    if workspace is not None:
        url = f"{url}&workspace={urllib.parse.quote(workspace)}"
    with client.websocket_connect(url) as websocket:
        init = websocket.receive_json()
        yield websocket, init


def recv_until(websocket, type_name: str) -> dict:
    while True:
        message = websocket.receive_json()
        if message["type"] == type_name:
            return message


def test_init_has_workspaces_and_current_page(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, teacher_init):
        assert teacher_init["workspaces"] == [
            {"id": "ws_default", "name": "Страница 1", "position": 0}
        ]
        assert teacher_init["workspaceId"] == "ws_default"
        assert teacher_init["permissions"]["canManageWorkspaces"] is True

        with ws_connect(client, ws_url, student["token"]) as (student_ws, student_init):
            assert student_init["permissions"]["canManageWorkspaces"] is False


def test_switch_is_per_user(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    observer = login_user("Наблюдатель", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
        ws_connect(client, ws_url, observer["token"]) as (observer_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(student_ws, "workspace_created")
        recv_until(observer_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched

        # The teacher returns to the default page.
        teacher_ws.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert recv_until(teacher_ws, "workspace_state")["workspaceId"] == "ws_default"

        # The student switches themselves; only the student is moved.
        student_ws.send_json({"type": "workspace_switch", "workspaceId": page_id})
        assert recv_until(student_ws, "workspace_state")["workspaceId"] == page_id

        # The teacher is still on the default page: their cursor reaches the
        # observer (also on the default page), never the student (on page 2).
        teacher_ws.send_json({"type": "cursor", "workspaceId": "ws_default", "x": 5, "y": 6})
        cursor = recv_until(observer_ws, "cursor")
        assert cursor["id"] == teacher["user"]["id"]


def test_student_cannot_manage_workspaces(client: TestClient, login_user, ws_url) -> None:
    student = login_user("Ученик", "student")

    with ws_connect(client, ws_url, student["token"]) as (student_ws, _):
        student_ws.send_json({"type": "workspace_create"})
        error = student_ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "forbidden"


def test_teacher_creates_page_and_creator_switches(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        created = recv_until(teacher_ws, "workspace_created")
        page_id = created["workspace"]["id"]
        recv_until(student_ws, "workspace_created")

        state = recv_until(teacher_ws, "workspace_state")
        assert state["workspaceId"] == page_id

        # The student stays on the default page: they receive the creator's
        # cursor_remove (scoped to the default page) and no workspace_state.
        assert student_ws.receive_json()["type"] == "cursor_remove"


def test_objects_are_isolated_between_pages(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    observer = login_user("Наблюдатель", "student")
    late = login_user("Опоздавший", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
        ws_connect(client, ws_url, observer["token"]) as (observer_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(student_ws, "workspace_created")
        recv_until(observer_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        student_ws.receive_json()  # creator's cursor_remove
        observer_ws.receive_json()  # creator's cursor_remove

        teacher_ws.send_json({**SHAPE, "objectId": "shape-p2", "workspaceId": page_id})
        student_ws.send_json({**SHAPE, "objectId": "shape-p1", "workspaceId": "ws_default"})

        # The observer (default page) sees only the page-1 shape, proving the
        # teacher's page-2 shape was not delivered across pages.
        first = observer_ws.receive_json()
        assert first["type"] == "shape_add"
        assert first["object"]["id"] == "shape-p1"

    with ws_connect(client, ws_url, late["token"], workspace=page_id) as (_, init):
        assert [obj["id"] for obj in init["objects"]] == ["shape-p2"]

    with ws_connect(client, ws_url, late["token"], workspace="ws_default") as (_, init):
        assert [obj["id"] for obj in init["objects"]] == ["shape-p1"]


def test_clear_only_current_page(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({**SHAPE, "objectId": "shape-p1", "workspaceId": "ws_default"})
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        teacher_ws.send_json({**SHAPE, "objectId": "shape-p2", "workspaceId": page_id})
        teacher_ws.send_json({"type": "clear", "workspaceId": page_id})

    with ws_connect(client, ws_url, teacher["token"], workspace="ws_default") as (_, init):
        assert [obj["id"] for obj in init["objects"]] == ["shape-p1"]

    with ws_connect(client, ws_url, teacher["token"], workspace=page_id) as (_, init):
        assert init["objects"] == []


def test_delete_last_workspace_is_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({"type": "workspace_delete", "workspaceId": "ws_default"})
        error = teacher_ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "last_workspace"


def test_delete_unknown_workspace_is_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({"type": "workspace_delete", "workspaceId": "ws_missing"})
        error = teacher_ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "workspace_not_found"


def test_delete_workspace_moves_viewers_to_fallback(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(student_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        student_ws.receive_json()  # creator's cursor_remove

        student_ws.send_json({"type": "workspace_switch", "workspaceId": page_id})
        recv_until(student_ws, "workspace_state")

        teacher_ws.send_json({"type": "workspace_delete", "workspaceId": page_id})

        deleted_t = recv_until(teacher_ws, "workspace_deleted")
        assert deleted_t["workspaceId"] == page_id
        assert deleted_t["fallbackId"] == "ws_default"

        deleted_s = recv_until(student_ws, "workspace_deleted")
        assert deleted_s["fallbackId"] == "ws_default"

        assert recv_until(teacher_ws, "workspace_state")["workspaceId"] == "ws_default"
        assert recv_until(student_ws, "workspace_state")["workspaceId"] == "ws_default"


def test_rename_and_reorder_broadcast(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
    ):
        teacher_ws.send_json(
            {"type": "workspace_rename", "workspaceId": "ws_default", "name": "Главная"}
        )
        renamed = recv_until(teacher_ws, "workspace_renamed")
        assert renamed["workspaceId"] == "ws_default"
        assert renamed["name"] == "Главная"
        renamed = recv_until(student_ws, "workspace_renamed")
        assert renamed["workspaceId"] == "ws_default"
        assert renamed["name"] == "Главная"

        teacher_ws.send_json({"type": "workspace_create", "name": "Вторая"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(student_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        student_ws.receive_json()  # creator's cursor_remove

        teacher_ws.send_json({"type": "workspace_reorder", "workspaceIds": [page_id, "ws_default"]})
        reordered = recv_until(teacher_ws, "workspace_reordered")
        assert reordered["workspaceIds"] == [page_id, "ws_default"]
        reordered = recv_until(student_ws, "workspace_reordered")
        assert reordered["workspaceIds"] == [page_id, "ws_default"]


def test_pull_single_student_two_phase(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, student["token"]) as (student_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(student_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        student_ws.receive_json()  # creator's cursor_remove

        teacher_ws.send_json({"type": "workspace_pull", "clientIds": [student["user"]["id"]]})

        prepare = recv_until(student_ws, "workspace_prepare_move")
        assert prepare["workspaceId"] == page_id

        student_ws.send_json({"type": "workspace_move_ack", "requestId": prepare["requestId"]})
        moved = recv_until(student_ws, "workspace_moved")
        assert moved["workspaceId"] == page_id
        state = recv_until(student_ws, "workspace_state")
        assert state["workspaceId"] == page_id


def test_pull_all_students(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    first = login_user("Первый", "student")
    second = login_user("Второй", "student")

    with (
        ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _),
        ws_connect(client, ws_url, first["token"]) as (first_ws, _),
        ws_connect(client, ws_url, second["token"]) as (second_ws, _),
    ):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(first_ws, "workspace_created")
        recv_until(second_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched
        first_ws.receive_json()  # creator's cursor_remove
        second_ws.receive_json()  # creator's cursor_remove

        teacher_ws.send_json({"type": "workspace_pull", "all": True})

        prepare_first = recv_until(first_ws, "workspace_prepare_move")
        prepare_second = recv_until(second_ws, "workspace_prepare_move")
        assert prepare_first["workspaceId"] == page_id
        assert prepare_second["workspaceId"] == page_id

        first_ws.send_json({"type": "workspace_move_ack", "requestId": prepare_first["requestId"]})
        second_ws.send_json(
            {"type": "workspace_move_ack", "requestId": prepare_second["requestId"]}
        )

        assert recv_until(first_ws, "workspace_state")["workspaceId"] == page_id
        assert recv_until(second_ws, "workspace_state")["workspaceId"] == page_id


def test_pull_all_without_students_is_silent(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({"type": "workspace_pull", "all": True})
        # Pressing "pull everyone" in an empty room is a no-op, not an error.
        teacher_ws.send_json({"type": "workspace_create"})
        assert teacher_ws.receive_json()["type"] == "workspace_created"


def test_stale_workspace_object_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    late = login_user("Опоздавший", "student")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched

        teacher_ws.send_json({**SHAPE, "objectId": "stale", "workspaceId": "ws_default"})
        error = recv_until(teacher_ws, "error")
        assert error["code"] == "stale_workspace"

    with ws_connect(client, ws_url, late["token"], workspace=page_id) as (_, init):
        assert [obj["id"] for obj in init["objects"]] == []


def test_stale_object_without_workspace_field(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({**SHAPE, "objectId": "shape-p1", "workspaceId": "ws_default"})
        teacher_ws.send_json({"type": "workspace_create"})
        recv_until(teacher_ws, "workspace_created")
        recv_until(teacher_ws, "workspace_state")  # creator auto-switched

        # An old client omits workspaceId but edits an object on another page.
        teacher_ws.send_json({"type": "object_update", "objectId": "shape-p1", "x": 50, "y": 60})
        error = recv_until(teacher_ws, "error")
        assert error["code"] == "stale_workspace"


def test_workspace_query_param_restores_page(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, ws_url, teacher["token"]) as (teacher_ws, _):
        teacher_ws.send_json({"type": "workspace_create"})
        page_id = recv_until(teacher_ws, "workspace_created")["workspace"]["id"]
        recv_until(teacher_ws, "workspace_state")

    with ws_connect(client, ws_url, teacher["token"], workspace=page_id) as (_, init):
        assert init["workspaceId"] == page_id
        assert [ws["id"] for ws in init["workspaces"]] == ["ws_default", page_id]

    # An unknown page id falls back to the first page.
    with ws_connect(client, ws_url, teacher["token"], workspace="ws_missing") as (_, init):
        assert init["workspaceId"] == "ws_default"
