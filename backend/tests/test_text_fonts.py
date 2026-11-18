"""Шрифты объектов «Текст»."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until, shape


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
        assert recv_until(tw, "error")["code"] == "invalid_message"


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
