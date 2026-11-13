"""Offset cursors bound to the result list they were issued for.

A cursor carries a fingerprint of the query and the index content, so one issued for another
query, filter or deployment is rejected instead of silently paging through different results.
"""

import base64
import hashlib
import json

from kb_mcp.domain import InvalidCursorError

_VERSION = 1


def fingerprint(*parts: str | None) -> str:
    joined = "\x1f".join(part or "" for part in parts)
    return hashlib.sha256(joined.encode()).hexdigest()[:16]


def encode_cursor(offset: int, print_: str) -> str:
    payload = json.dumps({"v": _VERSION, "h": print_, "o": offset}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None, print_: str) -> int:
    """The offset a cursor points at; 0 without one. Raises InvalidCursorError."""
    if not cursor:
        return 0
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except ValueError:  # bad base64, bad UTF-8 and bad JSON are all ValueErrors
        raise InvalidCursorError from None
    if not isinstance(data, dict):
        raise InvalidCursorError
    offset = data.get("o")
    if data.get("v") != _VERSION or data.get("h") != print_ or type(offset) is not int or offset < 0:
        raise InvalidCursorError
    return offset


def next_cursor(offset: int, limit: int, total: int, print_: str) -> str | None:
    end = offset + limit
    return encode_cursor(end, print_) if end < total else None
