"""Image storage backends: local uploads dir or an S3-compatible bucket."""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from app.config import Settings

logger = logging.getLogger(__name__)

FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
LOCAL_URL_PATTERN = re.compile(r"^/uploads/([A-Za-z0-9_.-]{1,128})$")


class ImageStorage(Protocol):
    """Common interface used by upload and WebSocket handlers."""

    async def startup(self) -> None: ...  # pragma: no cover - protocol

    async def close(self) -> None: ...  # pragma: no cover - protocol

    async def save(self, filename: str, data: bytes, content_type: str) -> str:
        """Persist the bytes and return the public URL."""
        ...  # pragma: no cover - protocol

    async def exists(self, url: str) -> bool:
        """Return True only for objects owned by this storage."""
        ...  # pragma: no cover - protocol

    async def check(self) -> bool:
        """Readiness probe for the backing store."""
        ...  # pragma: no cover - protocol


class LocalImageStorage:
    """Stores images on disk and serves them under ``/uploads``."""

    def __init__(self, uploads_dir: Path) -> None:
        self.uploads_dir = uploads_dir

    async def startup(self) -> None:
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

    async def close(self) -> None:
        return None

    async def save(self, filename: str, data: bytes, content_type: str) -> str:
        if not FILENAME_PATTERN.fullmatch(filename):
            raise ValueError("invalid filename")
        destination = self.uploads_dir / filename
        await asyncio.to_thread(destination.write_bytes, data)
        return f"/uploads/{filename}"

    async def exists(self, url: str) -> bool:
        match = LOCAL_URL_PATTERN.fullmatch(url)
        if match is None:
            return False
        return (self.uploads_dir / match.group(1)).is_file()

    async def check(self) -> bool:
        return self.uploads_dir.is_dir()


class S3ImageStorage:
    """Stores images in an S3-compatible bucket (AWS S3, MinIO, etc.)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.bucket = settings.s3_bucket
        self._client = None

    # ----------------------------------------------------------------- helpers

    def _build_client(self):
        import boto3

        return boto3.client(
            "s3",
            endpoint_url=self.settings.s3_endpoint_url or None,
            region_name=self.settings.s3_region,
            aws_access_key_id=self.settings.s3_access_key or None,
            aws_secret_access_key=self.settings.s3_secret_key or None,
            use_ssl=self.settings.s3_use_ssl,
        )

    @property
    def client(self):
        if self._client is None:
            self._client = self._build_client()
        return self._client

    def _public_base(self) -> str:
        if self.settings.s3_public_base_url:
            return self.settings.s3_public_base_url.rstrip("/")
        if self.settings.s3_endpoint_url:
            return f"{self.settings.s3_endpoint_url.rstrip('/')}/{self.bucket}"
        return f"https://{self.bucket}.s3.{self.settings.s3_region}.amazonaws.com"

    def _url_for(self, key: str) -> str:
        return f"{self._public_base()}/{key}"

    def _key_for(self, url: str) -> str | None:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None
        base = urlsplit(self._public_base())
        if parsed.scheme != base.scheme or parsed.netloc != base.netloc:
            return None
        prefix = base.path.rstrip("/") + "/"
        if not parsed.path.startswith(prefix):
            return None
        key = parsed.path[len(prefix) :]
        return key if FILENAME_PATTERN.fullmatch(key) else None

    # ---------------------------------------------------------------- interface

    async def startup(self) -> None:
        if not self.settings.s3_create_bucket:
            return

        def _ensure_bucket() -> None:
            from botocore.exceptions import ClientError

            try:
                self.client.head_bucket(Bucket=self.bucket)
            except ClientError:
                self.client.create_bucket(Bucket=self.bucket)
                logger.info("Created S3 bucket %s", self.bucket)

        await asyncio.to_thread(_ensure_bucket)

    async def close(self) -> None:
        self._client = None

    async def save(self, filename: str, data: bytes, content_type: str) -> str:
        if not FILENAME_PATTERN.fullmatch(filename):
            raise ValueError("invalid filename")
        extra = {"ACL": "public-read"} if self.settings.s3_public_read else {}
        await asyncio.to_thread(
            self.client.put_object,
            Bucket=self.bucket,
            Key=filename,
            Body=data,
            ContentType=content_type,
            **extra,
        )
        return self._url_for(filename)

    async def exists(self, url: str) -> bool:
        key = self._key_for(url)
        if key is None:
            return False

        def _head() -> bool:
            from botocore.exceptions import ClientError

            try:
                self.client.head_object(Bucket=self.bucket, Key=key)
            except ClientError:
                return False
            return True

        return await asyncio.to_thread(_head)

    async def check(self) -> bool:
        def _check() -> bool:
            try:
                self.client.head_bucket(Bucket=self.bucket)
            except Exception:  # noqa: BLE001 - readiness reports the failure
                logger.exception("S3 readiness check failed for bucket %s", self.bucket)
                return False
            return True

        return await asyncio.to_thread(_check)


def build_image_storage(settings: Settings) -> ImageStorage:
    if settings.s3_enabled:
        return S3ImageStorage(settings)
    return LocalImageStorage(settings.uploads_dir)
