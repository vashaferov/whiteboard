"""Pydantic schemas: REST payloads and client -> server WebSocket messages."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
    model_validator,
)

ROOM_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
OBJECT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
WORKSPACE_ID_PATTERN = r"^ws_[A-Za-z0-9_-]{1,64}$"
WORKSPACE_REQUEST_PATTERN = r"^mv_[a-f0-9]{32}$"
COLOR_PATTERN = r"^#[0-9a-fA-F]{6}$"
UPLOAD_URL_PATTERN = r"^(?:/uploads/[A-Za-z0-9_.-]{1,128}|https?://[^\s\"']{1,500})$"

COORD_MIN = -1_000_000.0
COORD_MAX = 1_000_000.0


class BoardSize(BaseModel):
    width: int
    height: int


class UserInfo(BaseModel):
    id: str
    name: str
    role: Literal["teacher", "student", "admin"]
    color: str
    login: str = ""


class Permissions(BaseModel):
    canDraw: bool
    canClear: bool
    canDelete: bool
    canManageUsers: bool
    canManageWorkspaces: bool
    canCreateRooms: bool
    canManageAccounts: bool


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str = Field(pattern=r"^[A-Za-z0-9_.-]{3,32}$")
    name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("Имя не может быть пустым")
        return cleaned

    @field_validator("password")
    @classmethod
    def _password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Пароль не длиннее 72 байт")
        return value


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=72)


class AuthResponse(BaseModel):
    user: UserInfo
    permissions: Permissions
    board: BoardSize


class RoomName(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("Название не может быть пустым")
        return cleaned


class RoomCreate(RoomName):
    pass


class RoomRename(RoomName):
    pass


class RoomAccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    userIds: list[str] = Field(default_factory=list, max_length=500)


class RoomOwner(BaseModel):
    id: str
    name: str


class RoomInfo(BaseModel):
    id: str
    name: str
    owner: RoomOwner


class StudentInfo(BaseModel):
    id: str
    name: str
    login: str


class AdminUser(BaseModel):
    id: str
    login: str
    name: str
    role: str
    status: str
    createdAt: str


class AdminUserPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["active", "blocked", "rejected"] | None = None
    role: Literal["student", "teacher"] | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> AdminUserPatch:
        if self.status is None and self.role is None:
            raise ValueError("Укажите статус или роль")
        return self


class AdminPasswordReset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=8, max_length=72)

    @field_validator("password")
    @classmethod
    def _password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Пароль не длиннее 72 байт")
        return value


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class _Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    workspaceId: str | None = Field(default=None, pattern=WORKSPACE_ID_PATTERN)


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
    shapeType: Literal["rect", "circle", "line", "arrow", "process", "decision", "terminator"]
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float = Field(ge=COORD_MIN, le=COORD_MAX)
    height: float = Field(ge=COORD_MIN, le=COORD_MAX)
    color: str = Field(pattern=COLOR_PATTERN)
    strokeWidth: float = Field(ge=1, le=200)
    fill: str | None = Field(default=None, pattern=COLOR_PATTERN)


TEXT_FONT_VALUES = ("sans", "serif", "mono", "hand", "narrow")
TextFontFamily = Literal["sans", "serif", "mono", "hand", "narrow"]


class TextAdd(_Message):
    type: Literal["text_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    content: str = Field(min_length=1, max_length=2000)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    color: str = Field(pattern=COLOR_PATTERN)
    fontSize: float = Field(ge=8, le=200)
    fontFamily: TextFontFamily = "sans"


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


class ConnectorAdd(_Message):
    type: Literal["connector_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    fromId: str = Field(pattern=OBJECT_ID_PATTERN)
    toId: str = Field(pattern=OBJECT_ID_PATTERN)
    color: str = Field(pattern=COLOR_PATTERN)
    strokeWidth: float = Field(ge=1, le=200)


class FrameAdd(_Message):
    type: Literal["frame_add"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float = Field(ge=COORD_MIN, le=COORD_MAX)
    height: float = Field(ge=COORD_MIN, le=COORD_MAX)
    fill: str | None = Field(default=None, pattern=COLOR_PATTERN)
    pattern: Literal["none", "lines", "grid"] = "none"
    stroke: str = Field(default="#94a3b8", pattern=COLOR_PATTERN)
    strokeWidth: float = Field(default=2, ge=1, le=50)


class FrameMove(_Message):
    type: Literal["frame_move"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class FrameStyle(_Message):
    type: Literal["frame_style"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    fill: str | None = Field(default=None, pattern=COLOR_PATTERN)
    pattern: Literal["none", "lines", "grid"] = "none"


class ObjectTransform(_Message):
    type: Literal["object_transform"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)
    width: float | None = Field(default=None, ge=-10000, le=10000)
    height: float | None = Field(default=None, ge=-10000, le=10000)
    rotation: float = Field(default=0, ge=-360, le=360)
    fontSize: float | None = Field(default=None, ge=8, le=200)


class MoveEntry(BaseModel):
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class ObjectsDelete(_Message):
    type: Literal["objects_delete"]
    objectIds: list[str] = Field(min_length=1, max_length=200)


class ObjectsMove(_Message):
    type: Literal["objects_move"]
    updates: list[MoveEntry] = Field(min_length=1, max_length=200)


class BoardResize(_Message):
    type: Literal["board_resize"]
    width: int = Field(ge=640, le=4000)
    height: int = Field(ge=640, le=4000)


class WorkspaceCanvas(_Message):
    type: Literal["workspace_canvas"]
    mode: Literal["infinite", "fixed"]
    width: int | None = Field(default=None, ge=640, le=4000)
    height: int | None = Field(default=None, ge=640, le=4000)


class WorkspaceBackground(_Message):
    type: Literal["workspace_background"]
    color: str | None = Field(default=None, pattern=COLOR_PATTERN)


class TextUpdate(_Message):
    type: Literal["text_update"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    content: str = Field(min_length=1, max_length=2000)


class TextFont(_Message):
    type: Literal["text_font"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    fontFamily: TextFontFamily


class ObjectDelete(_Message):
    type: Literal["object_delete"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)


class ObjectLock(_Message):
    type: Literal["object_lock"]
    objectId: str = Field(pattern=OBJECT_ID_PATTERN)
    locked: bool


class Undo(_Message):
    type: Literal["undo"]


class SetInvisible(_Message):
    type: Literal["set_invisible"]
    invisible: bool


class Cursor(_Message):
    type: Literal["cursor"]
    x: float = Field(ge=COORD_MIN, le=COORD_MAX)
    y: float = Field(ge=COORD_MIN, le=COORD_MAX)


class Clear(_Message):
    type: Literal["clear"]


class Kick(_Message):
    type: Literal["kick"]
    clientId: str = Field(pattern=OBJECT_ID_PATTERN)


class WorkspaceSwitch(_Message):
    type: Literal["workspace_switch"]
    workspaceId: str = Field(pattern=WORKSPACE_ID_PATTERN)


class PresentationSlide(_Message):
    type: Literal["presentation_slide"]
    workspaceId: str | None = Field(default=None, pattern=WORKSPACE_ID_PATTERN)
    slideIndex: int = Field(ge=0, le=1000)


class WorkspaceCreate(_Message):
    type: Literal["workspace_create"]
    name: str | None = Field(default=None, min_length=1, max_length=60)
    kind: Literal["page", "presentation"] = "page"
    slides: list[Annotated[str, Field(pattern=UPLOAD_URL_PATTERN)]] = Field(
        default_factory=list, max_length=80
    )

    @field_validator("name")
    @classmethod
    def _clean_optional_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Название страницы не может быть пустым")
        return cleaned

    @model_validator(mode="after")
    def _check_slides(self) -> WorkspaceCreate:
        if self.kind == "presentation" and not self.slides:
            raise ValueError("В презентации нет слайдов")
        if self.kind == "page" and self.slides:
            raise ValueError("У обычной страницы не может быть слайдов")
        return self


class WorkspaceRename(_Message):
    type: Literal["workspace_rename"]
    workspaceId: str = Field(pattern=WORKSPACE_ID_PATTERN)
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Название страницы не может быть пустым")
        return cleaned


class WorkspaceDelete(_Message):
    type: Literal["workspace_delete"]
    workspaceId: str = Field(pattern=WORKSPACE_ID_PATTERN)


class WorkspaceReorder(_Message):
    type: Literal["workspace_reorder"]
    workspaceIds: list[str] = Field(min_length=1, max_length=50)

    @field_validator("workspaceIds")
    @classmethod
    def _check_ids(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Идентификаторы страниц не должны повторяться")
        for workspace_id in value:
            if re.fullmatch(WORKSPACE_ID_PATTERN, workspace_id) is None:
                raise ValueError("Некорректный идентификатор страницы")
        return value


class WorkspacePull(_Message):
    type: Literal["workspace_pull"]
    clientIds: list[str] = Field(default_factory=list, max_length=100)
    all: bool = False

    @model_validator(mode="after")
    def _check_mode(self) -> WorkspacePull:
        if self.all == bool(self.clientIds):
            raise ValueError("Укажите либо all=true, либо непустой clientIds")
        for client_id in self.clientIds:
            if re.fullmatch(OBJECT_ID_PATTERN, client_id) is None:
                raise ValueError("Некорректный идентификатор участника")
        return self


class WorkspaceMoveAck(_Message):
    type: Literal["workspace_move_ack"]
    requestId: str = Field(pattern=WORKSPACE_REQUEST_PATTERN)


ClientMessage = Annotated[
    StrokeStart
    | StrokePoint
    | StrokeEnd
    | ShapeAdd
    | TextAdd
    | ImageAdd
    | ObjectUpdate
    | ConnectorAdd
    | FrameAdd
    | FrameMove
    | FrameStyle
    | ObjectTransform
    | TextUpdate
    | TextFont
    | BoardResize
    | WorkspaceCanvas
    | WorkspaceBackground
    | ObjectsDelete
    | ObjectsMove
    | ObjectDelete
    | ObjectLock
    | Undo
    | SetInvisible
    | PresentationSlide
    | Cursor
    | Clear
    | Kick
    | WorkspaceSwitch
    | WorkspaceCreate
    | WorkspaceRename
    | WorkspaceDelete
    | WorkspaceReorder
    | WorkspacePull
    | WorkspaceMoveAck,
    Field(discriminator="type"),
]

client_message_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


def permissions_for(role: str) -> Permissions:
    is_staff = role in ("teacher", "admin")
    return Permissions(
        canDraw=True,
        canClear=is_staff,
        canDelete=is_staff,
        canManageUsers=is_staff,
        canManageWorkspaces=is_staff,
        canCreateRooms=is_staff,
        canManageAccounts=role == "admin",
    )
