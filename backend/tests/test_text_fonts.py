"""Стили объектов «Текст»: шрифт, размер, цвет и начертание."""

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


def style(object_id: str = "t1", **overrides) -> dict:
    payload = {"type": "text_style", "objectId": object_id}
    payload.update(overrides)
    return payload


def run(text: str, **overrides) -> dict:
    payload = {
        "text": text,
        "color": "#111827",
        "fontSize": 24,
        "fontFamily": "sans",
        "bold": False,
        "italic": False,
        "underline": False,
    }
    payload.update(overrides)
    return payload


def test_text_created_with_style_and_default(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        tw.send_json(
            text(
                "t1",
                fontFamily="serif",
                fontSize=32,
                color="#dc2626",
                bold=True,
                italic=True,
                underline=True,
            )
        )
        created = recv_until(sw, "text_add")["object"]
        assert created["fontFamily"] == "serif"
        assert created["fontSize"] == 32
        assert created["color"] == "#dc2626"
        assert created["bold"] is True
        assert created["italic"] is True
        assert created["underline"] is True

        tw.send_json(text("t2"))
        default = recv_until(sw, "text_add")["object"]
        assert default["fontFamily"] == "sans"
        assert default["bold"] is False
        assert default["italic"] is False
        assert default["underline"] is False

        tw.send_json(text("t3", fontFamily="comic"))
        assert recv_until(tw, "error")["code"] == "invalid_message"
        tw.send_json(text("t4", fontSize=500))
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_style_change_permissions_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(text("t1"))
        recv_until(sw, "text_add")

        sw.send_json(style("t1", bold=True))
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json(
            style(
                "t1",
                fontFamily="mono",
                fontSize=40,
                color="#2563eb",
                bold=True,
                italic=True,
                underline=True,
            )
        )
        changed = recv_until(sw, "text_style")["object"]
        assert changed["fontFamily"] == "mono"
        assert changed["fontSize"] == 40
        assert changed["color"] == "#2563eb"
        assert changed["bold"] is True
        assert changed["italic"] is True
        assert changed["underline"] is True

        tw.send_json(style("t1", bold=False, italic=False, underline=False))
        cleared = recv_until(sw, "text_style")["object"]
        assert cleared["bold"] is False
        assert cleared["italic"] is False
        assert cleared["underline"] is False

        tw.send_json(shape("s1"))
        recv_until(sw, "shape_add")
        tw.send_json(style("s1", bold=True))
        assert codes(barrier(tw)) == ["not_text"]

        tw.send_json({"type": "object_lock", "objectId": "t1", "locked": True})
        recv_until(sw, "object_lock")
        sw.send_json(style("t1", fontSize=18))
        assert "locked" in codes(barrier(sw))
        tw.send_json(style("t1", fontSize=18))
        assert "locked" in codes(barrier(tw))

        tw.send_json({"type": "object_lock", "objectId": "t1", "locked": False})
        recv_until(sw, "object_lock")
        tw.send_json(style("t1", fontSize=18))
        assert recv_until(sw, "text_style")["object"]["fontSize"] == 18


def test_style_change_is_undoable(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", fontFamily="serif"))
        barrier(tw)
        tw.send_json(
            style(
                "t1",
                fontFamily="mono",
                fontSize=40,
                color="#dc2626",
                bold=True,
                italic=True,
                underline=True,
            )
        )
        barrier(tw)

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")
        assert restored["removedIds"] == []
        restored_object = restored["objects"][0]["object"]
        assert restored_object["fontFamily"] == "serif"
        assert restored_object["fontSize"] == 24
        assert restored_object["color"] == "#111827"
        assert restored_object["bold"] is False
        assert restored_object["italic"] is False
        assert restored_object["underline"] is False

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["t1"]


def test_text_runs_are_saved_and_undoable(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", content="Привет мир"))
        recv_until(sw, "text_add")

        runs = [run("Привет "), run("мир", color="#dc2626", fontSize=32, bold=True)]
        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": runs,
                "fontFamily": "serif",
            }
        )
        updated = recv_until(sw, "text_update")["object"]
        assert updated["content"] == "Привет мир"
        assert updated["runs"] == runs
        assert updated["fontFamily"] == "serif"

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")["objects"][0]["object"]
        assert restored["content"] == "Привет мир"
        assert not restored.get("runs")
        assert restored["fontFamily"] == "sans"


def test_text_runs_must_match_content(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", content="Привет мир"))
        barrier(tw)

        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": [run("Привет")],
            }
        )
        assert recv_until(tw, "error")["code"] == "invalid_message"

        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": [run("Привет "), run("мир", color="red")],
            }
        )
        assert recv_until(tw, "error")["code"] == "invalid_message"

        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": [run("Привет "), run("мир", fontSize=5)],
            }
        )
        assert recv_until(tw, "error")["code"] == "invalid_message"

        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": [run("Привет "), run("мир", fontFamily="comic")],
            }
        )
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_text_add_accepts_runs(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        runs = [run("При"), run("вет", italic=True, underline=True)]
        tw.send_json(text("t1", content="Привет", runs=runs))
        created = recv_until(sw, "text_add")["object"]
        assert created["runs"] == runs

        tw.send_json(text("t2", content="Привет", runs=[run("При")]))
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_style_patch_updates_every_run_and_keeps_other_formatting(
    client: TestClient, login_user
) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", content="Привет мир"))
        recv_until(sw, "text_add")
        runs = [run("Привет "), run("мир", bold=True, fontSize=32)]
        tw.send_json(
            {
                "type": "text_update",
                "objectId": "t1",
                "content": "Привет мир",
                "runs": runs,
            }
        )
        recv_until(sw, "text_update")

        tw.send_json(style("t1", color="#2563eb", fontFamily="mono"))
        changed = recv_until(sw, "text_style")["object"]
        assert changed["color"] == "#2563eb"
        assert changed["runs"][0]["color"] == "#2563eb"
        assert changed["runs"][1]["color"] == "#2563eb"
        assert changed["runs"][1]["bold"] is True
        assert changed["runs"][1]["fontSize"] == 32
        assert changed["runs"][0]["fontFamily"] == "mono"
        assert changed["runs"][1]["fontFamily"] == "mono"

        tw.send_json(style("t1", bold=False))
        cleared = recv_until(sw, "text_style")["object"]
        assert all(item["bold"] is False for item in cleared["runs"])


def test_text_resize_scales_every_run_and_is_undoable(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        runs = [run("Привет "), run("мир", fontSize=32, bold=True)]
        tw.send_json(text("t1", content="Привет мир", runs=runs))
        recv_until(sw, "text_add")

        tw.send_json(
            {
                "type": "object_transform",
                "objectId": "t1",
                "x": 10,
                "y": 20,
                "rotation": 0,
                "fontSize": 48,
            }
        )
        resized = recv_until(sw, "object_transform")["object"]
        assert resized["fontSize"] == 48
        assert [item["fontSize"] for item in resized["runs"]] == [48, 64]
        assert resized["runs"][1]["bold"] is True

        tw.send_json({"type": "undo"})
        restored = recv_until(tw, "objects_restored")["objects"][0]["object"]
        assert restored["fontSize"] == 24
        assert [item["fontSize"] for item in restored["runs"]] == [24, 32]


def test_text_resize_keeps_uniform_text_without_runs(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        tw.send_json(text("t1", content="Текст"))
        recv_until(sw, "text_add")
        tw.send_json(
            {
                "type": "object_transform",
                "objectId": "t1",
                "x": 10,
                "y": 20,
                "rotation": 0,
                "fontSize": 32,
            }
        )
        resized = recv_until(sw, "object_transform")["object"]
        assert resized["fontSize"] == 32
        assert not resized.get("runs")


def test_empty_style_is_rejected(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json(text("t1"))
        barrier(tw)

        tw.send_json(style("t1"))
        assert tw.receive_json()["code"] == "invalid_message"
        tw.send_json(style("t1", color="red"))
        assert tw.receive_json()["code"] == "invalid_message"
