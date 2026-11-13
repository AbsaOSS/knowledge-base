from collections.abc import Callable
from pathlib import Path

import pytest

from kb_mcp.compose import open_knowledge_base
from kb_mcp.config import Settings
from kb_mcp.domain import InvalidOffsetError, UnknownDocumentError
from kb_mcp.service import MAX_RESOURCE_CHARS, KnowledgeBase

from .conftest import Site


def test_results_carry_absolute_links_when_the_public_origin_is_known(kb: KnowledgeBase, index_path: Path) -> None:
    [listed] = kb.list_documents(title="rotation").documents
    with open_knowledge_base(Settings(index=index_path)) as relative:
        [listed_relative] = relative.list_documents(title="rotation").documents

    assert listed.url == "https://docs.example.com/knowledge-base/ops-guide/runbooks/rotation/"
    assert listed_relative.url is None
    assert listed.route == "/knowledge-base/ops-guide/runbooks/rotation/"
    assert listed.app_name == "Operations Guide"
    assert (listed.section, listed.tags) == ("Runbooks", ["ops", "platform"])


def test_search_results_name_the_section_to_link_to(kb: KnowledgeBase) -> None:
    results = kb.search("retention")

    assert results.results[0].section is not None
    assert results.results[0].section.anchor == "retention"
    assert results.total >= 1


def test_reads_a_document_a_slice_at_a_time(kb: KnowledgeBase) -> None:
    whole = kb.read("kb://ops-guide")
    first = kb.read("kb://ops-guide", max_chars=10)

    assert first.text == whole.text[:10]
    assert first.next_offset == 10
    assert first.total_chars == len(whole.text)
    rest = kb.read("kb://ops-guide", offset=10, max_chars=50_000)
    assert first.text + rest.text == whole.text
    assert rest.next_offset is None


def test_reading_past_the_end_or_an_unknown_document_is_a_client_error(kb: KnowledgeBase) -> None:
    with pytest.raises(InvalidOffsetError):
        kb.read("kb://ops-guide", offset=10_000)
    with pytest.raises(UnknownDocumentError, match="kb://nope"):
        kb.read("kb://nope")


def test_a_resource_starts_with_its_provenance(kb: KnowledgeBase) -> None:
    text = kb.resource_text("kb://ops-guide/runbooks/rotation")

    assert text.startswith(
        "Title: Password rotation\n"
        "App: Operations Guide (ops-guide)\n"
        "Link: https://docs.example.com/knowledge-base/ops-guide/runbooks/rotation/\n"
        "Source version: v1.0.0\n\n---\n\n# Password rotation"
    )


def test_a_long_resource_is_cut_and_points_to_read_document(site: Site, make_index: Callable[[Site], Path]) -> None:
    site.page("dev-handbook", "long", f"<main><p>{'x' * (MAX_RESOURCE_CHARS + 10)}</p></main>")
    with open_knowledge_base(Settings(index=make_index(site))) as kb:
        assert kb.resource_text("kb://dev-handbook/long").endswith("continue with read_document.]")


def test_all_documents_pages_through_the_whole_repository(kb: KnowledgeBase) -> None:
    assert len(kb.all_documents()) == 6
