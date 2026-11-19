"""Workspace (page) metadata helpers.

A room keeps an ordered list of workspace dicts ``{"id", "name", "position"}``.
The helpers below keep that list valid when it comes from a snapshot, a Redis
hash or an untrusted client, and repair legacy objects that were stored before
workspaces existed.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from app.models.schemas import COLOR_PATTERN, WORKSPACE_ID_PATTERN

DEFAULT_WORKSPACE_ID = "ws_default"
DEFAULT_WORKSPACE_NAME = "Страница 1"
MAX_WORKSPACE_NAME_LENGTH = 60
PRESENTATION_KIND = "presentation"
MAX_PRESENTATION_SLIDES = 80
CANVAS_MIN = 640
CANVAS_MAX = 4000
CANVAS_RATIO = 4

_WORKSPACE_ID_RE = re.compile(WORKSPACE_ID_PATTERN)
_BACKGROUND_RE = re.compile(COLOR_PATTERN)
_PAGE_NAME_RE = re.compile(r"^Страница (\d+)$")

# Missing / malformed positions sort after every explicit one, keeping input order.
_MISSING_POSITION = 1_000_000


def new_workspace_id() -> str:
    """Return a fresh workspace id of the form ``ws_<uuidhex>``."""
    return f"ws_{uuid.uuid4().hex}"


def default_workspace() -> dict[str, Any]:
    """Return the workspace every room starts with."""
    return {"id": DEFAULT_WORKSPACE_ID, "name": DEFAULT_WORKSPACE_NAME, "position": 0}


def normalize_canvas(raw: Any) -> dict[str, Any] | None:
    """Validate a fixed canvas; ``None`` means the page is infinite."""
    if not isinstance(raw, dict) or raw.get("mode") != "fixed":
        return None
    try:
        width = int(raw["width"])
        height = int(raw["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (CANVAS_MIN <= width <= CANVAS_MAX and CANVAS_MIN <= height <= CANVAS_MAX):
        return None
    if max(width / height, height / width) > CANVAS_RATIO:
        return None
    return {"mode": "fixed", "width": width, "height": height}


def normalize_background(raw: Any) -> str | None:
    """Validate a page background color; ``None`` means the default board."""
    if not isinstance(raw, str):
        return None
    color = raw.lower()
    return color if _BACKGROUND_RE.fullmatch(color) is not None else None


def _position(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return _MISSING_POSITION
    return value


def _clean_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:MAX_WORKSPACE_NAME_LENGTH]


def normalize_workspaces(raw: Any) -> list[dict[str, Any]]:
    """Coerce arbitrary snapshot data into an ordered, de-duplicated workspace list."""
    workspaces: list[dict[str, Any]] = []
    seen: set[str] = set()
    items = raw if isinstance(raw, list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        workspace_id = item.get("id")
        if not isinstance(workspace_id, str) or _WORKSPACE_ID_RE.fullmatch(workspace_id) is None:
            continue
        if workspace_id in seen:
            continue
        name = _clean_name(item.get("name"))
        if not name:
            continue
        seen.add(workspace_id)
        workspace: dict[str, Any] = {
            "id": workspace_id,
            "name": name,
            "position": _position(item.get("position")),
        }
        if item.get("kind") == PRESENTATION_KIND:
            slides = [
                slide
                for slide in item.get("slides") or []
                if isinstance(slide, str) and 1 <= len(slide) <= 500
            ][:MAX_PRESENTATION_SLIDES]
            index = item.get("slideIndex")
            if isinstance(index, bool) or not isinstance(index, int):
                index = 0
            workspace.update(
                kind=PRESENTATION_KIND,
                slides=slides,
                slideIndex=min(max(index, 0), max(len(slides) - 1, 0)),
            )
        else:
            canvas = normalize_canvas(item.get("canvas"))
            if canvas is not None:
                workspace["canvas"] = canvas
            background = normalize_background(item.get("background"))
            if background is not None:
                workspace["background"] = background
        workspaces.append(workspace)
    workspaces.sort(key=lambda workspace: workspace["position"])
    for position, workspace in enumerate(workspaces):
        workspace["position"] = position
    return workspaces or [default_workspace()]


def assign_orphan_objects(workspaces: list[dict[str, Any]], objects: list[dict[str, Any]]) -> None:
    """Attach objects without a known ``workspaceId`` to the first workspace."""
    valid_ids = [
        workspace["id"]
        for workspace in workspaces
        if isinstance(workspace, dict) and isinstance(workspace.get("id"), str)
    ]
    if not valid_ids:
        return
    known = set(valid_ids)
    fallback = valid_ids[0]
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        current = obj.get("workspaceId")
        if not isinstance(current, str) or current not in known:
            obj["workspaceId"] = fallback


def next_workspace_name(workspaces: list[dict[str, Any]]) -> str:
    """Return the next free default page name, e.g. ``Страница 4``."""
    highest = 0
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            continue
        name = workspace.get("name")
        if not isinstance(name, str):
            continue
        match = _PAGE_NAME_RE.match(name.strip())
        if match is not None:
            highest = max(highest, int(match.group(1)))
    number = highest + 1 if highest else len(workspaces) + 1
    return f"Страница {number}"
