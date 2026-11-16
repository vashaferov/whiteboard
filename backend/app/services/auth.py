"""Password hashing, session ids and auth rate limiting."""

from __future__ import annotations

import hashlib
import secrets
import time
from collections import deque

import bcrypt

SESSION_COOKIE = "wb_session"

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


def pick_color(seed: str) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def hash_password(password: str, rounds: int) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (TypeError, ValueError):
        return False


def normalize_login(login: str) -> str:
    return login.strip().lower()


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def is_staff(role: str) -> bool:
    return role in ("teacher", "admin")


class WindowLimiter:
    """In-memory sliding-window limiter used for auth attempts."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> bool:
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self.window_seconds:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)
