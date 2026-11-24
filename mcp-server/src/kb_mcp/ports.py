"""What a storage backend implements. Cursors are opaque and owned by the adapter that issued them.

The ports are synchronous: the MCP SDK runs synchronous tools in worker threads, and an
adapter that needs I/O (a search cluster, say) can use a blocking client there.
"""

from typing import Protocol

from kb_mcp.domain import App, Document, DocumentFilter, IndexInfo, Page, PageRequest, SearchHit, SearchQuery


class DocumentRepository(Protocol):
    def info(self) -> IndexInfo: ...

    def apps(self) -> list[App]:
        """Every app, in slug order."""
        ...

    def get(self, uri: str) -> Document | None: ...

    def list_documents(self, document_filter: DocumentFilter, page: PageRequest) -> Page[Document]:
        """Documents in canonical order (app, then route). Raises InvalidCursorError."""
        ...


class SearchBackend(Protocol):
    def search(self, query: SearchQuery, page: PageRequest) -> Page[SearchHit]:
        """Best first, ties by URI. Raises EmptyQueryError and InvalidCursorError."""
        ...
