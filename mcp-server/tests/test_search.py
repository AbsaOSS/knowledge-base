"""Relevance of the SQLite backend: what a reader typing a question should get first."""

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from kb_mcp.adapters.cursor import encode_cursor, fingerprint
from kb_mcp.adapters.query import MAX_FUZZY_WORDS, expand, words
from kb_mcp.adapters.sqlite import IndexUnavailableError, SqliteIndex, SqliteSearch
from kb_mcp.domain import InvalidCursorError, PageRequest, SearchHit, SearchQuery
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


def test_points_at_the_section_whose_body_matches_when_no_heading_does(index_path: Path) -> None:
    with SqliteIndex(index_path) as index:
        hits = SqliteSearch(index).search(SearchQuery("passwords"), PageRequest(limit=10)).items
    hit = next(hit for hit in hits if hit.document.uri == "kb://ops-guide")

    assert hit.section is not None
    assert hit.section.anchor == "credentials"
    assert "passwords" in hit.excerpt


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


def test_a_one_letter_camel_case_head_stays_part_of_the_word() -> None:
    assert words("gRPC iOS eBPF mTLS jQuery") == ["grpc", "ios", "ebpf", "mtls", "jquery"]


def test_query_words_lose_their_diacritics_as_the_index_does() -> None:
    assert words("Café über Résumé Köln") == ["cafe", "uber", "resume", "koln"]


@pytest.mark.parametrize(
    ("query", "body"),
    [
        ("gRPC", "<main><h1>Transport</h1><p>Services talk gRPC to each other.</p></main>"),
        ("café", "<main><h1>Breaks</h1><p>The café opens at eight.</p></main>"),
        ("Köln", "<main><h1>Offices</h1><p>The office in Köln moved.</p></main>"),
    ],
)
def test_finds_words_the_tokenizer_indexed_as_one(tmp_path: Path, query: str, body: str) -> None:
    site = Site(tmp_path / "dist").app("a", "A").app("b", "B")
    site.page("a", "", body)
    site.page("b", "", "<main><h1>Other</h1><p>Remote procedure calls and operating systems.</p></main>")
    out = tmp_path / "index.sqlite"
    build_index(site.write(), out)

    hit = top(out, query)

    assert hit.document.uri == "kb://a"
    assert query.lower() in hit.excerpt.lower()


def test_only_a_few_unknown_words_are_matched_against_the_vocabulary() -> None:
    looked_up: list[str] = []

    def near(word: str) -> list[str]:
        looked_up.append(word)
        return []

    unknown = " ".join(f"qz{chr(97 + i // 26)}{chr(97 + i % 26)}x" for i in range(40))
    expand(unknown, lambda _: False, near)

    assert len(looked_up) == MAX_FUZZY_WORDS


def test_a_cursor_with_an_offset_no_page_could_reach_is_refused(index_path: Path) -> None:
    with SqliteIndex(index_path) as index:
        print_ = fingerprint(index.info.content_hash, "search", "vault", None, None)
        search = SqliteSearch(index)
        with pytest.raises(InvalidCursorError):
            search.search(SearchQuery("vault"), PageRequest(limit=5, cursor=encode_cursor(2**63, print_)))


def test_pages_through_results_whose_documents_are_large(tmp_path: Path) -> None:
    site = Site(tmp_path / "dist").app("big", "Big")
    for i in range(30):
        site.page("big", f"p{i:02}", f"<main><h1>Page {i}</h1><p>{'needle ' * (i + 1)}{'filler ' * 40_000}</p></main>")
    out = tmp_path / "index.sqlite"
    build_index(site.write(), out)

    with SqliteIndex(out) as index:
        search = SqliteSearch(index)
        first = search.search(SearchQuery("needle"), PageRequest(limit=25))
        rest = search.search(SearchQuery("needle"), PageRequest(limit=25, cursor=first.next_cursor))

    uris = [hit.document.uri for hit in first.items + rest.items]
    assert sorted(uris) == sorted(f"kb://big/p{i:02}" for i in range(30))
    assert [hit.score for hit in first.items] == sorted((hit.score for hit in first.items), reverse=True)
    assert all(len(hit.document.text) > 200_000 for hit in first.items)


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


def test_a_stemmed_form_of_an_indexed_word_is_still_searched() -> None:
    known = {"running"}

    assert "run" in expand("run", known.__contains__, lambda _: [])


def test_a_camel_case_identifier_inside_a_longer_question_is_kept_whole() -> None:
    known = {"eventbus"}

    assert "eventbus" in expand("how does EventBus work", known.__contains__, lambda _: [])
