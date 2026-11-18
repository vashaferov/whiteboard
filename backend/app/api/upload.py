"""Image upload endpoint (REST, out of the WebSocket channel)."""

from __future__ import annotations

import io
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.api.deps import (
    get_app_settings,
    get_auth_user,
    get_image_storage,
    require_same_origin,
)
from app.config import Settings
from app.services import metrics
from app.services.accounts import User
from app.services.auth import is_staff
from app.services.images import ImageStorage

router = APIRouter(prefix="/api", tags=["upload"], dependencies=[Depends(require_same_origin)])

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
    user: Annotated[User, Depends(get_auth_user)],
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
        "uploadedBy": user.id,
    }


@router.post("/presentations")
async def upload_presentation(
    file: Annotated[UploadFile, File()],
    user: Annotated[User, Depends(get_auth_user)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    images: Annotated[ImageStorage, Depends(get_image_storage)],
) -> dict[str, object]:
    if not is_staff(user.role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Загружать презентации может только учитель",
        )

    content_type = (file.content_type or "").lower()
    if content_type != "application/pdf":
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Поддерживаются только PDF-презентации",
        )

    limit = settings.max_presentation_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Файл пустой")
    if len(data) > limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Файл больше {settings.max_presentation_mb} МБ",
        )
    if not data.startswith(b"%PDF-"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Файл не является PDF",
        )

    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except Exception as exc:  # noqa: BLE001 - pdfium reports various errors
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Не удалось прочитать PDF",
        ) from exc

    try:
        page_count = len(pdf)
        if page_count < 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="В PDF нет страниц")
        if page_count > settings.max_presentation_slides:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"В презентации больше {settings.max_presentation_slides} слайдов",
            )

        base = uuid.uuid4().hex
        slides: list[str] = []
        total_bytes = 0
        for index in range(page_count):
            page = pdf[index]
            bitmap = None
            try:
                width, height = page.get_size()
                scale = min(1600 / max(width, 1), 1600 / max(height, 1))
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil().convert("RGB")
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=88, optimize=True)
                payload = buffer.getvalue()
                url = await images.save(f"{base}-{index + 1}.jpg", payload, "image/jpeg")
                slides.append(url)
                total_bytes += len(payload)
            finally:
                if bitmap is not None:
                    bitmap.close()
                page.close()

        metrics.UPLOAD_BYTES.inc(total_bytes)
        return {"slides": slides, "pageCount": len(slides)}
    finally:
        pdf.close()


__all__ = ["router"]
