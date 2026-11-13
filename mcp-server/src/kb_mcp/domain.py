"""What the knowledge base holds, independent of storage and of MCP."""

from dataclasses import dataclass, field
from typing import Literal

type AppKind = Literal["artifact", "iframe"]


@dataclass(frozen=True, slots=True)
class App:
    slug: str
    name: str
    description: str
    tags: tuple[str, ...] = ()
    kind: AppKind = "artifact"
    url: str | None = None
    source_version: str | None = None


@dataclass(frozen=True, slots=True)
class Section:
    heading: str
    anchor: str | None
    level: int
    start: int
    """Code-point offset into the document text, inclusive."""
    end: int
    """Code-point offset into the document text, exclusive."""


@dataclass(frozen=True, slots=True)
class Document:
    uri: str
    """`kb://<app>/<path>`, unique in the index."""
    app: str
    route: str
    """Site-absolute route, e.g. `/knowledge-base/<app>/<path>/`."""
    title: str
    description: str
    text: str
    """Markdown-like plain text extracted at build time."""
    tags: tuple[str, ...] = ()
    section: str | None = None
    """The navigation section the app's manifest puts the page in."""
    source_version: str | None = None
    sha256: str = ""
    truncated: bool = False
    sections: tuple[Section, ...] = ()


@dataclass(frozen=True, slots=True)
class IndexInfo:
    content_hash: str
    indexed_at: str
    generator: str
    path_prefix: str
    """The site's URL prefix, e.g. `knowledge-base`: every page route starts with `/{path_prefix}/`."""


@dataclass(frozen=True, slots=True)
class SearchQuery:
    text: str
    app: str | None = None
    tag: str | None = None


@dataclass(frozen=True, slots=True)
class DocumentFilter:
    app: str | None = None
    tag: str | None = None
    title: str | None = None
    """Case-insensitive substring of the title."""


@dataclass(frozen=True, slots=True)
class PageRequest:
    limit: int
    cursor: str | None = None


@dataclass(frozen=True, slots=True)
class SearchHit:
    document: Document
    excerpt: str
    score: float
    section: Section | None = None


@dataclass(frozen=True, slots=True)
class Page[T]:
    items: list[T] = field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None


class KnowledgeBaseError(Exception):
    """A request the knowledge base cannot answer; the message is safe to show a client."""


class UnknownDocumentError(KnowledgeBaseError):
    def __init__(self, uri: str) -> None:
        super().__init__(f"Unknown document: {uri}")


class InvalidCursorError(KnowledgeBaseError):
    def __init__(self) -> None:
        super().__init__("Invalid or expired cursor; repeat the request without one")


class EmptyQueryError(KnowledgeBaseError):
    def __init__(self) -> None:
        super().__init__("The query has no searchable words")


class InvalidOffsetError(KnowledgeBaseError):
    def __init__(self, offset: int, total: int) -> None:
        super().__init__(f"Offset {offset} is beyond the end of the document ({total} characters)")
