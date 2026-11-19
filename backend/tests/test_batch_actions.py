"""Групповые удаление и перемещение."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until, shape


def test_batch_delete_and_undo_once(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        for object_id in ("a", "b", "c"):
            tw.send_json({**shape(object_id), "x": 100, "y": 100})
            recv_until(sw, "shape_add")

        tw.send_json({"type": "objects_delete", "objectIds": ["a", "b"]})
        deleted = {m["objectId"] for m in barrier(sw) if m["type"] == "object_delete"}
        assert deleted == {"a", "b"}

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        assert {obj["object"]["id"] for obj in restored["objects"]} == {"a", "b"}


def test_batch_delete_respects_lock(client: TestClient, login_user) -> None:
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
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        for object_id in ("a", "b"):
            tw.send_json({**shape(object_id), "x": 10, "y": 20})
            recv_until(sw, "shape_add")

        tw.send_json(
            {
                "type": "objects_move",
                "updates": [
                    {"objectId": "a", "x": 300, "y": 300},
                    {"objectId": "b", "x": 400, "y": 400},
                ],
            }
        )
        moved = {m["objectId"] for m in barrier(sw) if m["type"] == "object_update"}
        assert moved == {"a", "b"}

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        by_id = {obj["object"]["id"]: obj["object"] for obj in restored["objects"]}
        assert (by_id["a"]["x"], by_id["a"]["y"]) == (10, 20)
        assert (by_id["b"]["x"], by_id["b"]["y"]) == (10, 20)
