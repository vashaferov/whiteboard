"""S3-compatible image storage tests (moto)."""

from __future__ import annotations

import base64
import uuid

import boto3
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient
from moto import mock_aws
from tests.support import cookie, ensure_test_room, login_session, make_active_account, ws_connect

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

BUCKET = "whiteboard-test"
PUBLIC_BASE = "https://cdn.example.test/media"


def s3_settings(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "s3_bucket": BUCKET,
            "s3_region": "us-east-1",
            "s3_access_key": "test-key",
            "s3_secret_key": "test-secret",
            "s3_public_base_url": PUBLIC_BASE,
            "s3_create_bucket": True,
        }
    )


def login(client: TestClient, role: str = "teacher") -> str:
    login_name = f"s3-{uuid.uuid4().hex[:8]}"
    user_id = make_active_account(client, login_name, "Анна", role=role)
    ensure_test_room(client, "room-s3", user_id, role)
    return login_session(client, login_name)


@mock_aws
def test_upload_stores_object_in_bucket(settings: Settings) -> None:
    app = create_app(s3_settings(settings))
    with TestClient(app) as client:
        token = login(client)
        response = client.post(
            "/api/upload",
            cookies=cookie(token),
            files={"file": ("pixel.png", PNG_1X1, "image/png")},
        )

    assert response.status_code == 200, response.text
    url = response.json()["url"]
    assert url == f"{PUBLIC_BASE}/{response.json()['filename']}"

    s3 = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test-key",
        aws_secret_access_key="test-secret",
    )
    body = s3.get_object(Bucket=BUCKET, Key=response.json()["filename"])["Body"].read()
    assert body == PNG_1X1


@mock_aws
def test_image_add_accepts_own_url_and_rejects_foreign(settings: Settings) -> None:
    app = create_app(s3_settings(settings))
    with TestClient(app) as client:
        token = login(client)
        upload = client.post(
            "/api/upload",
            cookies=cookie(token),
            files={"file": ("pixel.png", PNG_1X1, "image/png")},
        )
        assert upload.status_code == 200
        url = upload.json()["url"]

        with ws_connect(client, token, "room-s3") as ws:
            ws.receive_json()
            ws.send_json(
                {
                    "type": "image_add",
                    "objectId": "image-1",
                    "url": url,
                    "x": 10,
                    "y": 10,
                    "width": 100,
                    "height": 50,
                }
            )
            # Своё событие не возвращается — ошибка на следующее сообщение служит
            # барьером, гарантирующим обработку image_add до закрытия.
            ws.send_json({"type": "bogus"})
            assert ws.receive_json()["code"] == "invalid_message"

        with ws_connect(client, token, "room-s3") as ws:
            init = ws.receive_json()
            assert [obj["id"] for obj in init["objects"]] == ["image-1"]
            assert init["objects"][0]["url"] == url

            ws.send_json(
                {
                    "type": "image_add",
                    "objectId": "image-2",
                    "url": "https://evil.example.test/stolen.png",
                    "x": 10,
                    "y": 10,
                    "width": 100,
                    "height": 50,
                }
            )
            error = ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "unknown_image"

            ws.send_json(
                {
                    "type": "image_add",
                    "objectId": "image-3",
                    "url": f"{PUBLIC_BASE}/missing.png",
                    "x": 10,
                    "y": 10,
                    "width": 100,
                    "height": 50,
                }
            )
            error = ws.receive_json()
            assert error["code"] == "unknown_image"
