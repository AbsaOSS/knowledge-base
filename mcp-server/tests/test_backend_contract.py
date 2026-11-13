"""What every storage backend must do. A new adapter adds its factory to BACKENDS.

No ranking is pinned here, so a vector backend can pass it too.
"""

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path

import pytest

from kb_mcp.adapters.sqlite import SqliteDocuments, SqliteIndex, SqliteSearch
from kb_mcp.domain import (
    DocumentFilter,
    EmptyQueryError,
    InvalidCursorError,
    PageRequest,
    SearchQuery,
)
from kb_mcp.ports import DocumentRepository, SearchBackend

from .conftest import Site

type Backend = tuple[DocumentRepository, SearchBackend]


@contextmanager
def sqlite_backend(index: Path) -> Iterator[Backend]:
    with SqliteIndex(index) as opened:
        yield SqliteDocuments(opened), SqliteSearch(opened)


BACKENDS: dict[str, Callable[[Path], AbstractContextManager[Backend]]] = {"sqlite": sqlite_backend}


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, index_path: Path) -> Iterator[Backend]:
    with BACKENDS[request.param](index_path) as opened:
        yield opened


def test_lists_every_document_once_in_canonical_order_across_pages(backend: Backend) -> None:
    documents, _ = backend
    seen: list[tuple[str, str]] = []
    cursor = None
    while True:
        page = documents.list_documents(DocumentFilter(), PageRequest(limit=2, cursor=cursor))
        assert page.total == 6
        seen.extend((document.app, document.route) for document in page.items)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor

    assert seen == sorted(seen)
    assert len(seen) == 6


@pytest.mark.parametrize(
    ("document_filter", "uris"),
    [
        (DocumentFilter(app="dev-handbook"), ["kb://dev-handbook", "kb://dev-handbook/style"]),
        (DocumentFilter(tag="EXTERNAL"), ["kb://vendor-docs"]),
        (DocumentFilter(title="rotat"), ["kb://ops-guide/runbooks/rotation"]),
        (DocumentFilter(app="ops-guide", title="nothing"), []),
    ],
)
def test_filters_documents(backend: Backend, document_filter: DocumentFilter, uris: list[str]) -> None:
    documents, _ = backend

    page = documents.list_documents(document_filter, PageRequest(limit=50))

    assert [document.uri for document in page.items] == uris


def test_gets_a_document_with_its_sections(backend: Backend) -> None:
    documents, _ = backend

    document = documents.get("kb://ops-guide")

    assert document is not None
    assert [section.heading for section in document.sections] == ["Operations Guide", "Credentials"]
    assert documents.get("kb://ops-guide/missing") is None


def test_lists_apps_in_slug_order(backend: Backend) -> None:
    documents, _ = backend

    assert [app.slug for app in documents.apps()] == ["dev-handbook", "ops-guide", "vendor-docs"]


def test_search_is_deterministic_and_best_first(backend: Backend) -> None:
    _, search = backend

    first = search.search(SearchQuery("rotate passwords"), PageRequest(limit=10))
    again = search.search(SearchQuery("rotate passwords"), PageRequest(limit=10))

    assert [hit.document.uri for hit in first.items] == [hit.document.uri for hit in again.items]
    scores = [hit.score for hit in first.items]
    assert scores == sorted(scores, reverse=True)
    assert first.items[0].document.app == "ops-guide"


def test_search_pages_through_every_match(backend: Backend) -> None:
    _, search = backend
    query = SearchQuery("rotation messaging handbook style")
    whole = search.search(query, PageRequest(limit=25))
    assert whole.total >= 3

    first = search.search(query, PageRequest(limit=1))
    rest = search.search(query, PageRequest(limit=25, cursor=first.next_cursor))

    assert [hit.document.uri for hit in first.items + rest.items] == [hit.document.uri for hit in whole.items]


def test_search_filters_by_app_and_tag(backend: Backend) -> None:
    _, search = backend

    by_app = search.search(SearchQuery("review", app="ops-guide"), PageRequest(limit=10))
    by_tag = search.search(SearchQuery("vendor", tag="external"), PageRequest(limit=10))

    assert by_app.items == []
    assert [hit.document.uri for hit in by_tag.items] == ["kb://vendor-docs"]


def test_a_cursor_only_continues_the_query_and_filter_it_came_from(backend: Backend) -> None:
    documents, search = backend
    search_cursor = search.search(SearchQuery("rotation messaging handbook"), PageRequest(limit=1)).next_cursor
    list_cursor = documents.list_documents(DocumentFilter(), PageRequest(limit=1)).next_cursor

    with pytest.raises(InvalidCursorError):
        search.search(SearchQuery("vault"), PageRequest(limit=1, cursor=search_cursor))
    with pytest.raises(InvalidCursorError):
        documents.list_documents(DocumentFilter(app="ops-guide"), PageRequest(limit=1, cursor=list_cursor))
    with pytest.raises(InvalidCursorError):
        documents.list_documents(DocumentFilter(), PageRequest(limit=1, cursor="not-a-cursor"))


def test_a_cursor_does_not_survive_a_redeploy_with_different_content(
    site: Site, make_index: Callable[[Site], Path], index_path: Path
) -> None:
    with sqlite_backend(index_path) as (documents, _):
        cursor = documents.list_documents(DocumentFilter(), PageRequest(limit=1)).next_cursor
    site.page("dev-handbook", "new", "<main><p>New.</p></main>")

    with sqlite_backend(make_index(site)) as (redeployed, _), pytest.raises(InvalidCursorError):
        redeployed.list_documents(DocumentFilter(), PageRequest(limit=1, cursor=cursor))


def test_a_query_without_words_is_an_error_and_unknown_words_match_nothing(backend: Backend) -> None:
    _, search = backend

    with pytest.raises(EmptyQueryError):
        search.search(SearchQuery("!!! ?"), PageRequest(limit=5))
    page = search.search(SearchQuery("zzyzx"), PageRequest(limit=5))
    assert (page.items, page.total, page.next_cursor) == ([], 0, None)
