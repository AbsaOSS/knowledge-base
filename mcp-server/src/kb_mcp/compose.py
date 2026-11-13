"""Wires adapters to the facade. A new backend is a new adapter and a branch here."""

from collections.abc import Iterator
from contextlib import contextmanager

from kb_mcp.adapters.sqlite import SqliteDocuments, SqliteIndex, SqliteSearch
from kb_mcp.config import Settings
from kb_mcp.service import KnowledgeBase


@contextmanager
def open_knowledge_base(settings: Settings) -> Iterator[KnowledgeBase]:
    with SqliteIndex(settings.index) as index:
        yield KnowledgeBase(SqliteDocuments(index), SqliteSearch(index), public_origin=settings.public_origin)
