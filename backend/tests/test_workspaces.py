"""Workspace primitives and protocol schemas."""

from __future__ import annotations

import pytest
from app.models.schemas import (
    WorkspaceCreate,
    WorkspaceDelete,
    WorkspaceMoveAck,
    WorkspacePull,
    WorkspaceRename,
    WorkspaceReorder,
    WorkspaceSwitch,
    client_message_adapter,
    permissions_for,
)
from app.services.workspaces import (
    DEFAULT_WORKSPACE_ID,
    assign_orphan_objects,
    default_workspace,
    next_workspace_name,
    normalize_workspaces,
)
from pydantic import ValidationError


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


def test_workspace_messages_parse() -> None:
    assert (
        WorkspaceSwitch.model_validate(
            {"type": "workspace_switch", "workspaceId": "ws_default"}
        ).workspaceId
        == "ws_default"
    )
    assert WorkspaceCreate.model_validate({"type": "workspace_create"}).name is None
    assert (
        WorkspaceRename.model_validate(
            {"type": "workspace_rename", "workspaceId": "ws_a", "name": "Новая"}
        ).name
        == "Новая"
    )
    assert WorkspaceReorder.model_validate(
        {"type": "workspace_reorder", "workspaceIds": ["ws_a", "ws_b"]}
    ).workspaceIds == ["ws_a", "ws_b"]
    assert (
        client_message_adapter.validate_python(
            {"type": "workspace_switch", "workspaceId": "ws_default"}
        ).type
        == "workspace_switch"
    )


def test_delete_and_move_ack_parse() -> None:
    assert (
        WorkspaceDelete.model_validate(
            {"type": "workspace_delete", "workspaceId": "ws_a"}
        ).workspaceId
        == "ws_a"
    )
    request_id = f"mv_{'0' * 32}"
    assert (
        WorkspaceMoveAck.model_validate(
            {"type": "workspace_move_ack", "requestId": request_id}
        ).requestId
        == request_id
    )
    with pytest.raises(ValidationError):
        WorkspaceMoveAck.model_validate({"type": "workspace_move_ack", "requestId": "mv_wrong"})


def test_pull_requires_exactly_one_mode() -> None:
    with pytest.raises(ValidationError):
        WorkspacePull.model_validate({"type": "workspace_pull"})
    with pytest.raises(ValidationError):
        WorkspacePull.model_validate({"type": "workspace_pull", "all": True, "clientIds": ["u1"]})
    assert WorkspacePull.model_validate({"type": "workspace_pull", "all": True}).all is True
    assert WorkspacePull.model_validate(
        {"type": "workspace_pull", "clientIds": ["u1"]}
    ).clientIds == ["u1"]


def test_reorder_rejects_duplicates() -> None:
    with pytest.raises(ValidationError):
        WorkspaceReorder.model_validate(
            {"type": "workspace_reorder", "workspaceIds": ["ws_a", "ws_a"]}
        )


def test_reorder_rejects_invalid_ids() -> None:
    with pytest.raises(ValidationError):
        WorkspaceReorder.model_validate(
            {"type": "workspace_reorder", "workspaceIds": ["ws_a", "bad id"]}
        )


def test_teacher_can_manage_workspaces() -> None:
    assert permissions_for("teacher").canManageWorkspaces is True
    assert permissions_for("student").canManageWorkspaces is False
