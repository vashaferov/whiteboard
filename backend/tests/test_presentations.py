"""Presentation PDF upload and slide rendering."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from tests.support import cookie

PDF = (Path(__file__).parent / "fixtures" / "two-slides.pdf").read_bytes()


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


def test_presentations_reject_too_many_slides(client: TestClient, login_user, settings) -> None:
    teacher = login_user("Учитель", "teacher")
    settings.max_presentation_slides = 1
    response = client.post(
        "/api/presentations",
        cookies=cookie(teacher["token"]),
        files={"file": ("slides.pdf", PDF, "application/pdf")},
    )
    assert response.status_code in (400, 413)
