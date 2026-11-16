"""Application settings loaded from environment / .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Configuration with sensible defaults for local development."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    app_name: str = "Онлайн-доска"

    admin_login: str = "admin"
    admin_password: str = "admin-change-me"
    admin_name: str = "Администратор"
    session_ttl_hours: int = 12
    cookie_secure: bool = False
    password_rounds: int = 12
    auth_login_per_minute: int = 10
    auth_register_per_minute: int = 5

    board_width: int = 1600
    board_height: int = 900

    data_dir: Path = PROJECT_ROOT / "data"
    uploads_dir: Path = PROJECT_ROOT / "uploads"
    frontend_dir: Path = PROJECT_ROOT / "frontend"

    max_upload_mb: int = 5
    snapshot_interval_seconds: float = 2.0
    room_ttl_days: int = 30
    max_objects_per_room: int = 20000
    max_workspaces_per_room: int = 50
    workspace_move_timeout_seconds: float = 2.0
    max_message_bytes: int = 262144

    rate_limit_points_per_sec: int = 60
    rate_limit_cursors_per_sec: int = 25
    rate_limit_messages_per_sec: int = 40

    # S3-compatible image storage. Empty bucket means the local uploads dir.
    s3_bucket: str = ""
    s3_endpoint_url: str = ""
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_public_base_url: str = ""
    s3_use_ssl: bool = False
    s3_public_read: bool = False
    s3_create_bucket: bool = True

    # Redis room state / Pub/Sub. Empty URL keeps the single-process mode.
    redis_url: str = ""
    redis_prefix: str = "whiteboard"
    presence_ttl_seconds: int = 45
    heartbeat_seconds: int = 15

    # Observability
    log_json: bool = False
    log_level: str = "INFO"
    sentry_dsn: str = ""
    sentry_environment: str = "production"
    sentry_traces_sample_rate: float = 0.0
    metrics_enabled: bool = True

    @property
    def s3_enabled(self) -> bool:
        return bool(self.s3_bucket)

    @property
    def redis_enabled(self) -> bool:
        return bool(self.redis_url)


@lru_cache
def get_settings() -> Settings:
    """Return process-wide settings (used by the module level app factory)."""

    return Settings()
