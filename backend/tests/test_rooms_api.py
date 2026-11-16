"""REST tests for owned rooms and access grants."""

from __future__ import annotations

from tests.support import cookie, login_session

PASSWORD = "secret-1"


def create_user(client, activate_user, login: str, *, role: str | None = None) -> str:
    response = client.post(
        "/api/register",
        json={"login": login, "name": login.title(), "password": PASSWORD},
    )
    assert response.status_code == 201, response.text
    activate_user(login, role=role)
    return login_session(client, login, PASSWORD)


def test_teacher_creates_room_and_student_sees_only_granted(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    student = create_user(client, activate_user, "student-1")

    created = client.post("/api/rooms", json={"name": " Алгебра "}, cookies=cookie(teacher))
    assert created.status_code == 201, created.text
    room = created.json()
    assert room["id"].startswith("r_")
    assert room["name"] == "Алгебра"
    assert room["owner"]["name"] == "Teacher-1"

    assert client.get("/api/rooms", cookies=cookie(teacher)).json() == [room]
    assert client.get("/api/rooms", cookies=cookie(student)).json() == []

    student_id = client.get("/api/me", cookies=cookie(student)).json()["user"]["id"]
    updated = client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": [student_id]},
        cookies=cookie(teacher),
    )
    assert updated.status_code == 200
    assert [item["id"] for item in updated.json()] == [student_id]

    rooms = client.get("/api/rooms", cookies=cookie(student)).json()
    assert [item["id"] for item in rooms] == [room["id"]]
    assert client.get(f"/api/rooms/{room['id']}", cookies=cookie(student)).status_code == 200


def test_student_without_access_is_forbidden(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    student = create_user(client, activate_user, "student-1")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(teacher)).json()

    assert client.get(f"/api/rooms/{room['id']}", cookies=cookie(student)).status_code == 403
    assert client.get("/api/rooms/all", cookies=cookie(student)).status_code == 403


def test_other_teacher_cannot_manage_room(client, activate_user) -> None:
    owner = create_user(client, activate_user, "teacher-1", role="teacher")
    other = create_user(client, activate_user, "teacher-2", role="teacher")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(owner)).json()

    rename = client.patch(
        f"/api/rooms/{room['id']}",
        json={"name": "Чужая"},
        cookies=cookie(other),
    )
    assert rename.status_code == 403
    assert rename.json()["detail"]["code"] == "forbidden"

    deleted = client.delete(f"/api/rooms/{room['id']}", cookies=cookie(other))
    assert deleted.status_code == 403
    assert client.get("/api/rooms", cookies=cookie(owner)).json()[0]["name"] == "Комната"


def test_access_replacement_returns_list(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    first = create_user(client, activate_user, "student-1")
    second = create_user(client, activate_user, "student-2")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(teacher)).json()

    first_id = client.get("/api/me", cookies=cookie(first)).json()["user"]["id"]
    second_id = client.get("/api/me", cookies=cookie(second)).json()["user"]["id"]

    client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": [first_id, second_id]},
        cookies=cookie(teacher),
    )
    updated = client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": [second_id]},
        cookies=cookie(teacher),
    )

    assert [item["id"] for item in updated.json()] == [second_id]
    assert client.get("/api/rooms", cookies=cookie(first)).json() == []
    assert len(client.get("/api/rooms", cookies=cookie(second)).json()) == 1


def test_access_rejects_invalid_users(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(teacher)).json()
    teacher_id = client.get("/api/me", cookies=cookie(teacher)).json()["user"]["id"]

    missing = client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": ["u_missing"]},
        cookies=cookie(teacher),
    )
    assert missing.status_code == 400
    assert missing.json()["detail"]["code"] == "invalid_user"

    staff = client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": [teacher_id]},
        cookies=cookie(teacher),
    )
    assert staff.status_code == 400


def test_delete_room_removes_it_for_everyone(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    student = create_user(client, activate_user, "student-1")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(teacher)).json()
    student_id = client.get("/api/me", cookies=cookie(student)).json()["user"]["id"]
    client.put(
        f"/api/rooms/{room['id']}/access",
        json={"userIds": [student_id]},
        cookies=cookie(teacher),
    )

    assert client.delete(f"/api/rooms/{room['id']}", cookies=cookie(teacher)).status_code == 204
    assert client.get(f"/api/rooms/{room['id']}", cookies=cookie(teacher)).status_code == 404
    assert client.get("/api/rooms", cookies=cookie(student)).json() == []


def test_admin_sees_all_rooms_and_opens_them(client, activate_user, admin_session) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    room = client.post("/api/rooms", json={"name": "Комната"}, cookies=cookie(teacher)).json()

    all_rooms = client.get("/api/rooms/all", cookies=cookie(admin_session))
    assert all_rooms.status_code == 200
    assert [item["id"] for item in all_rooms.json()] == [room["id"]]
    assert client.get(f"/api/rooms/{room['id']}", cookies=cookie(admin_session)).status_code == 200


def test_teacher_searches_active_students(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")
    create_user(client, activate_user, "anna")
    client.post(
        "/api/register",
        json={"login": "pending", "name": "Пётр", "password": PASSWORD},
    )

    found = client.get("/api/users?q=ann", cookies=cookie(teacher))
    assert found.status_code == 200
    assert [item["login"] for item in found.json()] == ["anna"]

    denied = client.get("/api/users", cookies=cookie(login_session(client, "anna", PASSWORD)))
    assert denied.status_code == 403


def test_room_mutations_require_same_origin(client, activate_user) -> None:
    teacher = create_user(client, activate_user, "teacher-1", role="teacher")

    response = client.post(
        "/api/rooms",
        json={"name": "Комната"},
        cookies=cookie(teacher),
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "bad_origin"
