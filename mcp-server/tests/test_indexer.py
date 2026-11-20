import json
import shutil
import sqlite3
from collections.abc import Callable
from contextlib import closing
from pathlib import Path

import pytest
from pydantic import ValidationError

from kb_mcp.__main__ import main
from kb_mcp.indexer.build import build_index
from kb_mcp.indexer.manifest import load_manifest

from .conftest import Site

FIXTURES = Path(__file__).parent / "fixtures"


def rows(index: Path, sql: str) -> list[tuple[object, ...]]:
    with closing(sqlite3.connect(index)) as connection:
        return connection.execute(sql).fetchall()


def test_accepts_the_manifest_the_site_build_writes(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "_kb").mkdir(parents=True)
    shutil.copy(FIXTURES / "pages.json", dist / "_kb" / "pages.json")

    manifest = load_manifest(dist)

    assert {app.kind for app in manifest.apps} == {"artifact", "iframe"}
    assert all(page.file.endswith("/index.html") for page in manifest.pages)


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        (lambda m: m.update(schemaVersion=2), "schemaVersion"),
        (lambda m: m["pages"][0].update(file="../etc/passwd/index.html"), "file"),
        (lambda m: m["pages"][0].update(file="/abs/index.html"), "file"),
        (lambda m: m.update(unexpected=True), "unexpected"),
    ],
)
def test_rejects_a_manifest_it_does_not_understand(
    tmp_path: Path, change: Callable[[dict[str, object]], None], problem: str
) -> None:
    manifest = json.loads((FIXTURES / "pages.json").read_text(encoding="utf-8"))
    change(manifest)
    (tmp_path / "_kb").mkdir()
    (tmp_path / "_kb" / "pages.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValidationError, match=problem):
        load_manifest(tmp_path)


def test_indexes_every_page_with_its_app_and_uri(index_path: Path) -> None:
    documents = rows(index_path, "SELECT uri, app, route, title, section, source_version FROM documents ORDER BY id")

    assert documents == [
        ("kb://dev-handbook", "dev-handbook", "/knowledge-base/dev-handbook/", "Developer Handbook", None, "v1.0.0"),
        (
            "kb://dev-handbook/style",
            "dev-handbook",
            "/knowledge-base/dev-handbook/style/",
            "Code style",
            None,
            "v1.0.0",
        ),
        ("kb://ops-guide", "ops-guide", "/knowledge-base/ops-guide/", "Operations Guide", None, "v1.0.0"),
        ("kb://ops-guide/messaging", "ops-guide", "/knowledge-base/ops-guide/messaging/", "Messaging", None, "v1.0.0"),
        (
            "kb://ops-guide/runbooks/rotation",
            "ops-guide",
            "/knowledge-base/ops-guide/runbooks/rotation/",
            "Password rotation",
            "Runbooks",
            "v1.0.0",
        ),
        ("kb://vendor-docs", "vendor-docs", "/knowledge-base/vendor-docs/", "Vendor Docs", None, None),
    ]


def test_an_iframe_app_is_indexed_as_a_pointer_to_the_external_site(index_path: Path) -> None:
    [(text,)] = rows(index_path, "SELECT text FROM documents WHERE app = 'vendor-docs'")

    assert text == "# Vendor Docs\n\nThe vendor's own site.\n\nExternal documentation: https://vendor.example.com/docs"


def test_a_page_without_text_is_indexed_by_its_title_and_description(
    site: Site, make_index: Callable[[Site], Path]
) -> None:
    site.page("dev-handbook", "empty", "<main><img src='diagram.png'></main>", title="Diagram")

    [(text,)] = rows(make_index(site), "SELECT text FROM documents WHERE uri = 'kb://dev-handbook/empty'")

    assert text == "# Diagram\n\nHow we write and ship code."


def test_the_content_hash_changes_with_the_content_and_only_with_it(
    site: Site, make_index: Callable[[Site], Path]
) -> None:
    def content_hash() -> object:
        return rows(make_index(site), "SELECT value FROM meta WHERE key = 'content_hash'")[0][0]

    first = content_hash()
    assert content_hash() == first
    site.page("dev-handbook", "new", "<main><p>New page.</p></main>")
    assert content_hash() != first


def test_a_page_of_an_unknown_app_fails_the_build(site: Site, make_index: Callable[[Site], Path]) -> None:
    site.page("ghost", "", "<main><p>x</p></main>")

    with pytest.raises(ValueError, match="unknown app ghost"):
        make_index(site)


def test_rebuilding_replaces_the_index_in_one_step(site: Site, tmp_path: Path) -> None:
    out = tmp_path / "out" / "index.sqlite"
    build_index(site.write(), out)
    build_index(site.write(), out)

    assert out.is_file()
    assert not out.with_name("index.sqlite.partial").exists()


def test_the_command_line_builds_the_index(site: Site, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "cli.sqlite"

    assert main(["index", "--dist", str(site.write()), "--out", str(out)]) == 0
    assert "Indexed 6 document(s) from 3 app(s)" in capsys.readouterr().out


def test_the_command_line_explains_a_missing_manifest(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="build the site first"):
        main(["index", "--dist", str(tmp_path), "--out", str(tmp_path / "x.sqlite")])
