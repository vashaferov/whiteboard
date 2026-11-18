"""Размер холста комнаты."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def types(messages: list[dict]) -> list[str]:
    return [message["type"] for message in messages]


def test_board_size_defaults_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        init = tw.receive_json()
        assert init["board"] == {"width": 1600, "height": 900}
        sw.receive_json()
        barrier(tw)

        tw.send_json({"type": "board_resize", "width": 1200, "height": 800})
        assert "board_resize" in types(barrier(tw))
        assert "board_resize" in types(barrier(sw))

        sw.send_json({"type": "board_resize", "width": 900, "height": 700})
        assert codes(barrier(sw)) == ["forbidden"]


def test_board_size_bounds(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        for width, height in ((639, 900), (1600, 4001), (4000, 500), (2000, 400)):
            tw.send_json({"type": "board_resize", "width": width, "height": height})
            assert recv_until(tw, "error")["code"] == "invalid_message", (width, height)
        tw.send_json({"type": "board_resize", "width": 640, "height": 2560})
        assert "board_resize" in types(barrier(tw))
