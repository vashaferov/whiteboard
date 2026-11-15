"""Login endpoint: issues a JWT for a lesson room."""

from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.config import Settings
from app.models.schemas import (
    BoardSize,
    LoginRequest,
    LoginResponse,
    UserInfo,
    permissions_for,
)
from app.services.auth import create_token, pick_color

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request) -> LoginResponse:
    settings: Settings = request.app.state.settings

    if payload.role == "teacher":
        expected = settings.teacher_code
        provided = payload.code or ""
        if not expected or not hmac.compare_digest(provided, expected):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Неверный код учителя",
            )

    user_id = f"u_{uuid.uuid4().hex[:16]}"
    color = pick_color(user_id + payload.name)
    token = create_token(
        settings,
        user_id=user_id,
        name=payload.name,
        role=payload.role,
        room_id=payload.roomId,
        color=color,
    )

    return LoginResponse(
        token=token,
        user=UserInfo(id=user_id, name=payload.name, role=payload.role, color=color),
        roomId=payload.roomId,
        board=BoardSize(width=settings.board_width, height=settings.board_height),
        permissions=permissions_for(payload.role),
    )
