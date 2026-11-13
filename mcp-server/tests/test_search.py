"""Relevance of the SQLite backend: what a reader typing a question should get first."""

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from kb_mcp.adapters.query import expand, words
from kb_mcp.adapters.sqlite import IndexUnavailableError, SqliteIndex, SqliteSearch
from kb_mcp.domain import PageRequest, SearchHit, SearchQuery
from kb_mcp.indexer.build import build_index

from .conftest import Site


def top(index_path: Path, text: str) -> SearchHit:
    with SqliteIndex(index_path) as index:
        hits = SqliteSearch(index).search(SearchQuery(text), PageRequest(limit=5)).items
    assert hits, f"no result for {text!r}"
    return hits[0]


@pytest.mark.parametrize(
    ("query", "uri"),
    [
        ("how do I rotate passwords", "kb://ops-guide/runbooks/rotation"),  # stems: rotate ~ rotation
        ("eventbus", "kb://ops-guide/messaging"),  # the document writes EventBus
        ("Event Bus", "kb://ops-guide/messaging"),  # compact form of a multi-word query
        ("rotaton", "kb://ops-guide/runbooks/rotation"),  # misspelling
        ("mypy strict", "kb://dev-handbook/style"),
        ("vendor", "kb://vendor-docs"),  # app name and description are searchable
    ],
)
def test_ranks_the_expected_document_first(index_path: Path, query: str, uri: str) -> None:
    assert top(index_path, query).document.uri == uri


def test_points_at_the_section_whose_heading_names_the_query(index_path: Path) -> None:
    hit = top(index_path, "retention")

    assert hit.section is not None
    assert (hit.section.heading, hit.section.anchor) == ("Retention", "retention")
    assert hit.excerpt == "## Retention Events are kept for seven days."


def test_excerpt_is_cut_around_the_first_match(tmp_path: Path) -> None:
    site = Site(tmp_path / "dist").app("a", "A")
    site.page("a", "", f"<main><p>{'filler ' * 100}needle here {'filler ' * 100}</p></main>")
    out = tmp_path / "index.sqlite"
    build_index(site.write(), out)

    excerpt = top(out, "needle").excerpt
    assert excerpt.startswith("…")
    assert excerpt.endswith("…")
    assert "needle here" in excerpt


def test_query_words_split_camel_case_and_drop_single_letters() -> None:
    assert words("Rotate the EventBus v2 x 7") == ["rotate", "the", "event", "bus", "v2", "7"]


def test_expansion_keeps_stop_words_only_when_nothing_else_is_left() -> None:
    def known(word: str) -> bool:
        return word in {"how", "the", "vault"}

    assert expand("how to use the vault", known, lambda _: []) == ["vault"]
    assert expand("how the", known, lambda _: []) == ["how", "the"]


def test_an_index_from_another_schema_version_is_refused(index_path: Path) -> None:
    with closing(sqlite3.connect(index_path)) as connection, connection:
        connection.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'")

    with pytest.raises(IndexUnavailableError, match="schema version 99"):
        SqliteIndex(index_path)


def test_a_missing_or_corrupt_index_is_refused(tmp_path: Path) -> None:
    with pytest.raises(IndexUnavailableError, match="not found"):
        SqliteIndex(tmp_path / "missing.sqlite")
    corrupt = tmp_path / "corrupt.sqlite"
    corrupt.write_bytes(b"not a database" * 100)
    with pytest.raises(IndexUnavailableError, match="Unreadable"):
        SqliteIndex(corrupt)
