"""JWT issuing / verification helpers."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import timedelta

import jwt
from jwt import InvalidTokenError as PyJWTInvalidTokenError

from app.config import Settings

PALETTE = (
    "#2563eb",
    "#dc2626",
    "#16a34a",
    "#d97706",
    "#7c3aed",
    "#0891b2",
    "#db2777",
    "#65a30d",
    "#ea580c",
    "#4f46e5",
)


class TokenError(Exception):
    """Raised when a token is missing, malformed, expired or has wrong claims."""


@dataclass(frozen=True, slots=True)
class TokenPayload:
    user_id: str
    name: str
    role: str
    room_id: str
    color: str

    @property
    def is_teacher(self) -> bool:
        return self.role == "teacher"


def pick_color(seed: str) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def create_token(
    settings: Settings,
    *,
    user_id: str,
    name: str,
    role: str,
    room_id: str,
    color: str | None = None,
) -> str:
    now = int(time.time())
    payload = {
        "sub": user_id,
        "name": name,
        "role": role,
        "room": room_id,
        "color": color or pick_color(user_id),
        "iat": now,
        "exp": now + int(timedelta(hours=settings.jwt_ttl_hours).total_seconds()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(settings: Settings, token: str) -> TokenPayload:
    if not token:
        raise TokenError("Токен отсутствует")
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            options={"require": ["sub", "exp", "room", "role"]},
        )
    except PyJWTInvalidTokenError as exc:
        raise TokenError("Недействительный или просроченный токен") from exc

    role = claims.get("role")
    if role not in ("teacher", "student"):
        raise TokenError("Неизвестная роль")

    return TokenPayload(
        user_id=str(claims["sub"]),
        name=str(claims.get("name") or "Участник"),
        role=str(role),
        room_id=str(claims["room"]),
        color=str(claims.get("color") or pick_color(str(claims["sub"]))),
    )
