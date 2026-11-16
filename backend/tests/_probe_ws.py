from fastapi.testclient import TestClient
from tests.support import ws_connect


def shape(object_id: str) -> dict:
    return {
        "type": "shape_add",
        "objectId": object_id,
        "shapeType": "rect",
        "x": 10,
        "y": 10,
        "width": 50,
        "height": 40,
        "color": "#2563eb",
        "strokeWidth": 4,
        "fill": None,
    }


def recv_until(websocket, type_name: str) -> dict:
    while True:
        message = websocket.receive_json()
        print("recv", message.get("type"), flush=True)
        if message["type"] == type_name:
            return message


def test_probe(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        print(
            "inits",
            teacher_ws.receive_json()["type"],
            student_ws.receive_json()["type"],
            flush=True,
        )
        print("joined", teacher_ws.receive_json()["type"], flush=True)
        print("send teacher shape", flush=True)
        teacher_ws.send_json(shape("teacher-shape"))
        print("student got", recv_until(student_ws, "shape_add")["object"]["id"], flush=True)
        print("send student shape", flush=True)
        student_ws.send_json(shape("student-shape"))
        print("teacher got", recv_until(teacher_ws, "shape_add")["object"]["id"], flush=True)
        print("student delete own", flush=True)
        student_ws.send_json({"type": "object_delete", "objectId": "student-shape"})
        print("teacher delete", recv_until(teacher_ws, "object_delete")["objectId"], flush=True)
        print("student delete teacher", flush=True)
        student_ws.send_json({"type": "object_delete", "objectId": "teacher-shape"})
        print("student error", recv_until(student_ws, "error")["code"], flush=True)

    print("observer", flush=True)
    observer = login_user("Наблюдатель", "student")
    with ws_connect(client, observer["token"]) as observer_ws:
        init = observer_ws.receive_json()
        print("observer objects", [o["id"] for o in init["objects"]], flush=True)
