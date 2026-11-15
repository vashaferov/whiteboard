"""Pydantic schemas: REST payloads and client -> server WebSocket messages."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

ROOM_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
OBJECT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
COLOR_PATTERN = r"^#[0-9a-fA-F]{6}$"
UPLOAD_URL_PATTERN = r"^(?:/uploads/[A-Za-z0-9_.-]{1,128}|https?://[^\s\"']{1,500})$"

COORD_MIN = -20000.0
COORD_MAX = 20000.0


class BoardSize(BaseModel):
    width: int
    height: int


class UserInfo(BaseModel):
    id: str
    name: str
    role: Literal["teacher", "student"]
    color: str


class Permissions(BaseModel):
    canDraw: bool
    canClear: bool
    canDelete: bool
    canManageUsers: bool


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=40)
    roomId: str = Field(pattern=ROOM_ID_PATTERN)
    role: Literal["teacher", "student"]
    code: str | None = Field(default=None, max_length=100)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("Имя не может быть пустым")
        return cleaned


class LoginResponse(BaseModel):
    token: str
    user: UserInfo
    roomId: str
    board: BoardSize
    permissions: Permissions


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class _Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str


class StrokeStart(_Message):
    type: Literal["stroke_start"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    tool: Literal["brush", "eraser"]
    color: str = Field(pattern=COLOR_PATTERN)
    width: float = Field(ge=1, le=200)
    point: Point


class StrokePoint(_Message):
    type: Literal["stroke_point"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    point: Point


class StrokeEnd(_Message):
    type: Literal["stroke_end"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)


class ShapeAdd(_Message):
    type: Literal["shape_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    shapeType: Literal["rect", "circle", "line", "arrow"]
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float = Field(ge=COORD_MIN, le=COORD_MAX)
    height: float = Field(ge=COORD_MIN, le=COORD_MAX)
    color: str = Field(pattern=COLOR_PATTERN)
    strokeWidth: float = Field(ge=1, le=200)
    fill: str | None = Field(default=None, pattern=COLOR_PATTERN)


class TextAdd(_Message):
    type: Literal["text_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    content: str = Field(min_length=1, max_length=2000)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    color: str = Field(pattern=COLOR_PATTERN)
    fontSize: float = Field(ge=8, le=200)


class ImageAdd(_Message):
    type: Literal["image_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    url: str = Field(pattern=UPLOAD_URL_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float = Field(gt=0, le=10000)
    height: float = Field(gt=0, le=10000)


class ObjectUpdate(_Message):
    type: Literal["object_update"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class ObjectTransform(_Message):
    type: Literal["object_transform"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float | None = Field(default=None, ge=-10000, le=10000)
    height: float | None = Field(default=None, ge=-10000, le=10000)
    rotation: float = Field(default=0, ge=-360, le=360)
    fontSize: float | None = Field(default=None, ge=8, le=200)


class TextUpdate(_Message):
    type: Literal["text_update"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    content: str = Field(min_length=1, max_length=2000)


class ObjectDelete(_Message):
    type: Literal["object_delete"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)


class Cursor(_Message):
    type: Literal["cursor"]
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class Clear(_Message):
    type: Literal["clear"]


class Kick(_Message):
    type: Literal["kick"]
    clientId: str = Field(pattern=OBJECT_ID_PATTERN)


ClientMessage = Annotated[
    StrokeStart
    | StrokePoint
    | StrokeEnd
    | ShapeAdd
    | TextAdd
    | ImageAdd
    | ObjectUpdate
    | ObjectTransform
    | TextUpdate
    | ObjectDelete
    | Cursor
    | Clear
    | Kick,
    Field(discriminator="type"),
]

client_message_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


def permissions_for(role: str) -> Permissions:
    is_teacher = role == "teacher"
    return Permissions(
        canDraw=True,
        canClear=is_teacher,
        canDelete=is_teacher,
        canManageUsers=is_teacher,
    )
