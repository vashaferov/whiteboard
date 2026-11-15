"""Image upload endpoint (REST, out of the WebSocket channel)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.api.deps import get_app_settings, get_current_user, get_image_storage
from app.config import Settings
from app.services import metrics
from app.services.auth import TokenPayload
from app.services.images import ImageStorage

router = APIRouter(prefix="/api", tags=["upload"])

# content type -> (extension, accepted file signatures)
ALLOWED_TYPES: dict[str, tuple[str, tuple[bytes, ...]]] = {
    "image/png": (".png", (b"\x89PNG\r\n\x1a\n",)),
    "image/jpeg": (".jpg", (b"\xff\xd8\xff",)),
    "image/gif": (".gif", (b"GIF87a", b"GIF89a")),
    "image/webp": (".webp", (b"RIFF",)),
}


@router.post("/upload")
async def upload_image(
    file: Annotated[UploadFile, File()],
    user: Annotated[TokenPayload, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    images: Annotated[ImageStorage, Depends(get_image_storage)],
) -> dict[str, object]:
    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Поддерживаются только PNG, JPEG, GIF и WebP",
        )

    extension, signatures = ALLOWED_TYPES[content_type]
    limit = settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Пустой файл")
    if len(data) > limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Файл больше {settings.max_upload_mb} МБ",
        )

    if content_type == "image/webp":
        valid_signature = data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    else:
        valid_signature = any(data.startswith(signature) for signature in signatures)
    if not valid_signature:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Содержимое файла не похоже на изображение",
        )

    filename = f"{uuid.uuid4().hex}{extension}"
    url = await images.save(filename, data, content_type)
    metrics.UPLOAD_BYTES.inc(len(data))

    return {
        "url": url,
        "filename": filename,
        "size": len(data),
        "uploadedBy": user.user_id,
    }
