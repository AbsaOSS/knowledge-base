"""Both ports over the SQLite index the indexer wrote (`kb_mcp.index_format`).

The file is opened read-only and immutable: nothing at run time writes to it, and SQLite can
skip locking. The SDK runs tools in worker threads; they share one connection, which SQLite
serialises (queries take milliseconds, and nothing ever writes).
"""

import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Self

from kb_mcp.adapters import query as query_terms
from kb_mcp.adapters.cursor import decode_cursor, fingerprint, next_cursor
from kb_mcp.domain import (
    App,
    Document,
    DocumentFilter,
    EmptyQueryError,
    IndexInfo,
    Page,
    PageRequest,
    SearchHit,
    SearchQuery,
    Section,
)
from kb_mcp.index_format import SCHEMA_VERSION, SEARCH_WEIGHTS

_SERIALIZED = 3
_EXCERPT_LEAD = 120
_EXCERPT_LENGTH = 400
_FUZZY_LENGTH_SPREAD = 2

_DOCUMENT_COLUMNS = ", ".join(
    f"d.{column}"
    for column in (
        "id",
        "uri",
        "app",
        "route",
        "title",
        "description",
        "tags",
        "section",
        "source_version",
        "sha256",
        "truncated",
        "text",
    )
)

_FILTERS = """
    (:app IS NULL OR d.app = :app)
    AND (:tag IS NULL OR EXISTS (SELECT 1 FROM json_each(d.tags) WHERE lower(value) = lower(:tag)))
"""
_GET = f"SELECT {_DOCUMENT_COLUMNS} FROM documents d WHERE d.uri = :uri"
_LIST_WHERE = f"{_FILTERS} AND (:title IS NULL OR instr(lower(d.title), lower(:title)) > 0)"
_LIST_COUNT = f"SELECT count(*) FROM documents d WHERE {_LIST_WHERE}"
_LIST_PAGE = (
    f"SELECT {_DOCUMENT_COLUMNS} FROM documents d WHERE {_LIST_WHERE} "
    "ORDER BY d.app, d.route LIMIT :limit OFFSET :offset"
)
_SEARCH_MATCHES = f"FROM search JOIN documents d ON d.id = search.rowid WHERE search MATCH :match AND {_FILTERS}"
_SEARCH_COUNT = f"SELECT count(*) {_SEARCH_MATCHES}"
_SEARCH_PAGE = (
    f"SELECT {_DOCUMENT_COLUMNS}, bm25(search, {', '.join(map(str, SEARCH_WEIGHTS))}) AS rank {_SEARCH_MATCHES} "
    "ORDER BY rank, d.uri LIMIT :limit OFFSET :offset"
)
_SECTIONS = (
    'SELECT document_id, heading, anchor, level, start, "end" FROM sections '
    "WHERE document_id IN (SELECT value FROM json_each(:ids)) ORDER BY document_id, position"
)


class IndexUnavailableError(Exception):
    """The index file is missing, unreadable or from another schema version."""


class SqliteIndex:
    """An open index file. Construct the adapters from it; close it when the server stops."""

    def __init__(self, path: Path) -> None:
        if not path.is_file():
            raise IndexUnavailableError(f"Search index not found: {path}")
        if sqlite3.threadsafety != _SERIALIZED:
            raise IndexUnavailableError("This SQLite build cannot share a connection between threads")
        try:
            self._connection = sqlite3.connect(
                f"{path.resolve().as_uri()}?mode=ro&immutable=1", uri=True, check_same_thread=False
            )
        except sqlite3.Error as error:
            raise IndexUnavailableError(f"Cannot open search index: {error}") from error
        self._connection.row_factory = sqlite3.Row
        try:
            meta = dict(self._connection.execute("SELECT key, value FROM meta").fetchall())
        except sqlite3.DatabaseError as error:
            self.close()
            raise IndexUnavailableError(f"Unreadable search index: {error}") from error
        if meta.get("schema_version") != str(SCHEMA_VERSION):
            self.close()
            raise IndexUnavailableError(
                f"Search index schema version {meta.get('schema_version')}, this server reads {SCHEMA_VERSION}"
            )
        self.info = IndexInfo(
            content_hash=meta["content_hash"], indexed_at=meta["indexed_at"], generator=meta["generator"]
        )

    def connection(self) -> sqlite3.Connection:
        return self._connection

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class SqliteDocuments:
    def __init__(self, index: SqliteIndex) -> None:
        self._index = index
        rows = index.connection().execute("SELECT * FROM apps ORDER BY slug").fetchall()
        self._apps = [_app(row) for row in rows]

    def info(self) -> IndexInfo:
        return self._index.info

    def apps(self) -> list[App]:
        return list(self._apps)

    def get(self, uri: str) -> Document | None:
        connection = self._index.connection()
        row = connection.execute(_GET, {"uri": uri}).fetchone()
        return None if row is None else _documents(connection, [row])[0]

    def list_documents(self, document_filter: DocumentFilter, page: PageRequest) -> Page[Document]:
        print_ = fingerprint(
            self._index.info.content_hash, "list", document_filter.app, document_filter.tag, document_filter.title
        )
        offset = decode_cursor(page.cursor, print_)
        parameters = {"app": document_filter.app, "tag": document_filter.tag, "title": document_filter.title}
        connection = self._index.connection()
        total = connection.execute(_LIST_COUNT, parameters).fetchone()[0]
        rows = connection.execute(_LIST_PAGE, {**parameters, "limit": page.limit, "offset": offset}).fetchall()
        return Page(_documents(connection, rows), total, next_cursor(offset, page.limit, total, print_))


class SqliteSearch:
    def __init__(self, index: SqliteIndex) -> None:
        self._index = index
        vocabulary = [row[0] for row in index.connection().execute("SELECT term FROM vocabulary")]
        self._vocabulary = frozenset(vocabulary)
        self._by_length: dict[int, list[str]] = defaultdict(list)
        for term in vocabulary:
            self._by_length[len(term)].append(term)

    def search(self, query: SearchQuery, page: PageRequest) -> Page[SearchHit]:
        if not query_terms.words(query.text):
            raise EmptyQueryError
        print_ = fingerprint(self._index.info.content_hash, "search", query.text, query.app, query.tag)
        offset = decode_cursor(page.cursor, print_)
        terms = query_terms.expand(query.text, self._vocabulary.__contains__, self._near)
        if not terms:
            return Page()

        parameters = {"match": " OR ".join(f'"{term}"' for term in terms), "app": query.app, "tag": query.tag}
        connection = self._index.connection()
        total = connection.execute(_SEARCH_COUNT, parameters).fetchone()[0]
        rows = connection.execute(_SEARCH_PAGE, {**parameters, "limit": page.limit, "offset": offset}).fetchall()
        hits = [
            _hit(document, terms, -row["rank"])
            for document, row in zip(_documents(connection, rows), rows, strict=True)
        ]
        return Page(hits, total, next_cursor(offset, page.limit, total, print_))

    def _near(self, word: str) -> list[str]:
        """Known words of about the same length: the only candidates a misspelling can be close to."""
        lengths = range(len(word) - _FUZZY_LENGTH_SPREAD, len(word) + _FUZZY_LENGTH_SPREAD + 1)
        return [term for length in lengths for term in self._by_length.get(length, ())]


def _app(row: sqlite3.Row) -> App:
    return App(
        slug=row["slug"],
        name=row["name"],
        description=row["description"],
        tags=tuple(json.loads(row["tags"])),
        kind=row["kind"],
        url=row["url"],
        source_version=row["source_version"],
    )


def _documents(connection: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[Document]:
    sections: dict[int, list[Section]] = defaultdict(list)
    for row in connection.execute(_SECTIONS, {"ids": json.dumps([row["id"] for row in rows])}):
        sections[row["document_id"]].append(
            Section(row["heading"], row["anchor"], row["level"], row["start"], row["end"])
        )
    return [
        Document(
            uri=row["uri"],
            app=row["app"],
            route=row["route"],
            title=row["title"],
            description=row["description"],
            text=row["text"],
            tags=tuple(json.loads(row["tags"])),
            section=row["section"],
            source_version=row["source_version"],
            sha256=row["sha256"],
            truncated=bool(row["truncated"]),
            sections=tuple(sections[row["id"]]),
        )
        for row in rows
    ]


def _hit(document: Document, terms: list[str], score: float) -> SearchHit:
    """The first section whose heading names a search term (else the first section), and an excerpt from it."""
    section = next(
        (section for section in document.sections if set(query_terms.words(section.heading)) & set(terms)),
        document.sections[0] if document.sections else None,
    )
    content = document.text[section.start : section.end] if section else document.text
    return SearchHit(document=document, excerpt=_excerpt(content, terms), score=round(score, 4), section=section)


def _excerpt(content: str, terms: list[str]) -> str:
    """About 400 characters of `content` around the first occurrence of any term."""
    lower = content.lower()
    first = min((index for term in terms if (index := lower.find(term)) >= 0), default=0)
    start = max(0, first - _EXCERPT_LEAD)
    excerpt = " ".join(content[start : start + _EXCERPT_LENGTH].split())
    if start > 0:
        excerpt = f"…{excerpt}"
    if start + _EXCERPT_LENGTH < len(content):
        excerpt += "…"
    return excerpt
