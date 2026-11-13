"""The three read-only tools. Inputs are validated by the SDK from the type hints; outputs are the facade's models."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from kb_mcp.domain import KnowledgeBaseError
from kb_mcp.service import (
    DEFAULT_LIST_LIMIT,
    DEFAULT_READ_CHARS,
    DEFAULT_SEARCH_LIMIT,
    MAX_LIST_LIMIT,
    MAX_QUERY_LENGTH,
    MAX_READ_CHARS,
    MAX_SEARCH_LIMIT,
    MIN_READ_CHARS,
    DocumentList,
    DocumentSlice,
    KnowledgeBase,
    SearchResults,
)

READ_ONLY = ToolAnnotations(read_only_hint=True, idempotent_hint=True, destructive_hint=False, open_world_hint=False)

type App = Annotated[str | None, Field(description="Only documents of this app (its slug)", max_length=100)]
type Tag = Annotated[str | None, Field(description="Only documents of apps with this tag", max_length=100)]
type Cursor = Annotated[str | None, Field(description="`next_cursor` of the previous page", max_length=500)]


@contextmanager
def _client_errors() -> Iterator[None]:
    """A knowledge base error is the client's to fix: report it as a tool error, not a server fault."""
    try:
        yield
    except KnowledgeBaseError as error:
        raise ToolError(str(error)) from error


def register_tools(server: MCPServer, kb: KnowledgeBase) -> None:
    @server.tool(annotations=READ_ONLY)
    def search_documents(
        query: Annotated[str, Field(description="Key terms to search for", min_length=1, max_length=MAX_QUERY_LENGTH)],
        app: App = None,
        tag: Tag = None,
        limit: Annotated[int, Field(ge=1, le=MAX_SEARCH_LIMIT)] = DEFAULT_SEARCH_LIMIT,
        cursor: Cursor = None,
    ) -> SearchResults:
        """Search the documentation; best matches first, each with an excerpt and the best-matching section.

        Read a result with read_document, and point the user to its url (or route) plus the section anchor.
        """
        with _client_errors():
            return kb.search(query, app=app, tag=tag, limit=limit, cursor=cursor)

    @server.tool(annotations=READ_ONLY)
    def list_documents(
        app: App = None,
        tag: Tag = None,
        title: Annotated[str | None, Field(description="Case-insensitive part of the title", max_length=200)] = None,
        limit: Annotated[int, Field(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: Cursor = None,
    ) -> DocumentList:
        """List documents in a stable order (app, then route), optionally filtered."""
        with _client_errors():
            return kb.list_documents(app=app, tag=tag, title=title, limit=limit, cursor=cursor)

    @server.tool(annotations=READ_ONLY)
    def read_document(
        uri: Annotated[str, Field(description="A document's kb:// URI", pattern=r"^kb://", max_length=1_000)],
        offset: Annotated[
            int, Field(description="Character to start at; `next_offset` of the previous read", ge=0)
        ] = 0,
        max_chars: Annotated[int, Field(ge=MIN_READ_CHARS, le=MAX_READ_CHARS)] = DEFAULT_READ_CHARS,
    ) -> DocumentSlice:
        """Read a document's text (markdown), a slice at a time; continue from `next_offset` until it is null."""
        with _client_errors():
            return kb.read(uri, offset=offset, max_chars=max_chars)
