"""The facade the protocol layer talks to.

It turns backend results into what clients see (links, app names, bounded reads) and knows
nothing about MCP; the backends behind it know nothing about clients.
"""

from urllib.parse import urljoin

from pydantic import BaseModel

from kb_mcp.domain import (
    App,
    Document,
    DocumentFilter,
    IndexInfo,
    InvalidOffsetError,
    PageRequest,
    SearchQuery,
    UnknownDocumentError,
)
from kb_mcp.ports import DocumentRepository, SearchBackend

DEFAULT_SEARCH_LIMIT = 8
MAX_SEARCH_LIMIT = 25
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 100
DEFAULT_READ_CHARS = 20_000
MIN_READ_CHARS = 1_000
MAX_READ_CHARS = 50_000
MAX_QUERY_LENGTH = 200
MAX_RESOURCE_CHARS = 100_000


class PublicDocument(BaseModel):
    uri: str
    title: str
    app: str
    app_name: str
    route: str
    """Site-absolute path of the page."""
    url: str | None
    """Absolute link, when the server knows its public origin."""


class SectionRef(BaseModel):
    heading: str
    anchor: str | None
    """Fragment identifier to append to the link, when the heading has a safe one."""


class SearchResult(PublicDocument):
    section: SectionRef | None
    excerpt: str
    score: float


class SearchResults(BaseModel):
    query: str
    total: int
    results: list[SearchResult]
    next_cursor: str | None


class ListedDocument(PublicDocument):
    description: str
    tags: list[str]
    section: str | None
    size: int
    """Length of the document text in characters."""


class DocumentList(BaseModel):
    total: int
    documents: list[ListedDocument]
    next_cursor: str | None


class DocumentSlice(PublicDocument):
    offset: int
    total_chars: int
    text: str
    next_offset: int | None
    """Pass as `offset` to continue; absent at the end of the document."""


class KnowledgeBase:
    def __init__(
        self, documents: DocumentRepository, search_backend: SearchBackend, public_origin: str | None = None
    ) -> None:
        self._documents = documents
        self._search_backend = search_backend
        self._public_origin = public_origin
        self._app_names = {app.slug: app.name for app in documents.apps()}

    def info(self) -> IndexInfo:
        return self._documents.info()

    def apps(self) -> list[App]:
        return self._documents.apps()

    def search(
        self,
        query: str,
        app: str | None = None,
        tag: str | None = None,
        limit: int = DEFAULT_SEARCH_LIMIT,
        cursor: str | None = None,
    ) -> SearchResults:
        page = self._search_backend.search(SearchQuery(query, app, tag), PageRequest(limit, cursor))
        results = [
            SearchResult(
                **self._public(hit.document).model_dump(),
                section=SectionRef(heading=hit.section.heading, anchor=hit.section.anchor) if hit.section else None,
                excerpt=hit.excerpt,
                score=hit.score,
            )
            for hit in page.items
        ]
        return SearchResults(query=query, total=page.total, results=results, next_cursor=page.next_cursor)

    def list_documents(
        self,
        app: str | None = None,
        tag: str | None = None,
        title: str | None = None,
        limit: int = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> DocumentList:
        page = self._documents.list_documents(DocumentFilter(app, tag, title), PageRequest(limit, cursor))
        documents = [
            ListedDocument(
                **self._public(document).model_dump(),
                description=document.description,
                tags=list(document.tags),
                section=document.section,
                size=len(document.text),
            )
            for document in page.items
        ]
        return DocumentList(total=page.total, documents=documents, next_cursor=page.next_cursor)

    def all_documents(self) -> list[Document]:
        """Every document in canonical order, for the resource listing."""
        documents: list[Document] = []
        cursor: str | None = None
        while True:
            page = self._documents.list_documents(DocumentFilter(), PageRequest(MAX_LIST_LIMIT, cursor))
            documents.extend(page.items)
            if page.next_cursor is None:
                return documents
            cursor = page.next_cursor

    def read(self, uri: str, offset: int = 0, max_chars: int = DEFAULT_READ_CHARS) -> DocumentSlice:
        document = self._require(uri)
        total = len(document.text)
        if offset > total:
            raise InvalidOffsetError(offset, total)
        end = min(total, offset + max_chars)
        return DocumentSlice(
            **self._public(document).model_dump(),
            offset=offset,
            total_chars=total,
            text=document.text[offset:end],
            next_offset=end if end < total else None,
        )

    def resource_text(self, uri: str) -> str:
        """A document as a resource: provenance first, then the text up to MAX_RESOURCE_CHARS."""
        document = self._require(uri)
        link = self._link(document)
        header = [
            f"Title: {document.title}",
            f"App: {self._app_name(document)} ({document.app})",
            f"Link: {link}",
            f"Source version: {document.source_version or 'unknown'}",
        ]
        text = document.text[:MAX_RESOURCE_CHARS]
        if len(document.text) > MAX_RESOURCE_CHARS:
            text += f"\n\n[Truncated at {MAX_RESOURCE_CHARS} characters; continue with read_document.]"
        return "\n".join(header) + "\n\n---\n\n" + text

    def link(self, document: Document) -> str:
        return self._link(document)

    def _require(self, uri: str) -> Document:
        document = self._documents.get(uri)
        if document is None:
            raise UnknownDocumentError(uri)
        return document

    def _app_name(self, document: Document) -> str:
        return self._app_names.get(document.app, document.app)

    def _absolute_url(self, document: Document) -> str | None:
        return urljoin(self._public_origin, document.route) if self._public_origin else None

    def _link(self, document: Document) -> str:
        return self._absolute_url(document) or document.route

    def _public(self, document: Document) -> PublicDocument:
        return PublicDocument(
            uri=document.uri,
            title=document.title,
            app=document.app,
            app_name=self._app_name(document),
            route=document.route,
            url=self._absolute_url(document),
        )
