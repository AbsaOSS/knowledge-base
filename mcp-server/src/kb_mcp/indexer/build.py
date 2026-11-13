"""Builds the SQLite search index from a site build's dist/ directory."""

import hashlib
import json
import logging
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from urllib.parse import quote

from kb_mcp.domain import Section
from kb_mcp.index_format import SCHEMA, SCHEMA_VERSION
from kb_mcp.indexer.extract import ExtractedDocument, extract_document
from kb_mcp.indexer.manifest import ManifestApp, ManifestPage, PageManifest, load_manifest

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class IndexStats:
    apps: int
    documents: int
    content_hash: str


@dataclass(frozen=True, slots=True)
class _Row:
    uri: str
    page: ManifestPage
    app: ManifestApp
    extracted: ExtractedDocument

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.extracted.text.encode()).hexdigest()


def document_uri(manifest: PageManifest, page: ManifestPage) -> str:
    """`kb://<app>/<path>`; `kb://<app>` for the app's root page."""
    path = manifest.path_within_app(page)
    return f"kb://{page.app}/{quote(path, safe='/')}" if path else f"kb://{page.app}"


def build_index(dist: Path, out: Path, now: datetime | None = None) -> IndexStats:
    """Read `dist/_kb/pages.json` and the pages it lists; write the index to `out`, replacing it atomically."""
    manifest = load_manifest(dist)
    rows = sorted(_rows(manifest, dist), key=lambda row: (row.page.app, row.page.route))
    content_hash = hashlib.sha256(
        json.dumps(
            [[app.model_dump(mode="json") for app in manifest.apps], [[row.uri, row.sha256] for row in rows]],
            sort_keys=True,
        ).encode()
    ).hexdigest()

    partial = out.with_name(out.name + ".partial")
    partial.unlink(missing_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(partial)
    try:
        with connection:
            try:
                connection.executescript(SCHEMA)
            except sqlite3.OperationalError as error:
                raise RuntimeError(f"This SQLite cannot build the index (is FTS5 compiled in?): {error}") from error
            _write_meta(connection, manifest, content_hash, now or datetime.now(UTC))
            _write_apps(connection, manifest.apps)
            for document_id, row in enumerate(rows, start=1):
                _write_document(connection, document_id, row)
        connection.execute("VACUUM")
    finally:
        connection.close()
    partial.replace(out)
    return IndexStats(apps=len(manifest.apps), documents=len(rows), content_hash=content_hash)


def _rows(manifest: PageManifest, dist: Path) -> Iterator[_Row]:
    seen: set[str] = set()
    for page in manifest.pages:
        app = manifest.app(page.app)
        if app is None:
            raise ValueError(f"Page {page.route} belongs to unknown app {page.app}")
        uri = document_uri(manifest, page)
        if uri in seen:
            raise ValueError(f"Two pages map to {uri}")
        seen.add(uri)
        yield _Row(uri, page, app, _extract(page, app, dist))


def _extract(page: ManifestPage, app: ManifestApp, dist: Path) -> ExtractedDocument:
    if app.kind == "iframe":
        text = "\n\n".join(filter(None, [f"# {app.name}", app.description, f"External documentation: {app.url}"]))
        return ExtractedDocument(app.name, app.description, text, (Section(app.name, None, 1, 0, len(text)),), False)

    html = (dist / page.file).read_text(encoding="utf-8")
    extracted = extract_document(html, page_title=page.title, fallback_title=app.name)
    if extracted.truncated:
        logger.warning("%s: text truncated for the index", page.route)
    if extracted.text:
        return extracted
    logger.warning("%s: no text extracted; indexing the title and description only", page.route)
    title = extracted.title or app.name
    description = extracted.description or app.description
    text = "\n\n".join(filter(None, [f"# {title}", description]))
    return ExtractedDocument(title, description, text, (), False)


def _write_meta(connection: sqlite3.Connection, manifest: PageManifest, content_hash: str, now: datetime) -> None:
    meta = {
        "schema_version": str(SCHEMA_VERSION),
        "content_hash": content_hash,
        "indexed_at": now.isoformat(timespec="seconds"),
        "generator": f"kb-mcp {version('kb-mcp')}",
        "path_prefix": manifest.path_prefix,
    }
    connection.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", meta.items())


def _write_apps(connection: sqlite3.Connection, apps: list[ManifestApp]) -> None:
    connection.executemany(
        "INSERT INTO apps (slug, name, description, tags, kind, url, source_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (app.slug, app.name, app.description, json.dumps(app.tags), app.kind, app.url, app.source_version)
            for app in apps
        ],
    )


def _write_document(connection: sqlite3.Connection, document_id: int, row: _Row) -> None:
    extracted, app = row.extracted, row.app
    description = extracted.description or app.description
    connection.execute(
        "INSERT INTO documents (id, uri, app, route, title, description, tags, section, source_version, sha256, "
        "truncated, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            document_id,
            row.uri,
            app.slug,
            row.page.route,
            extracted.title or app.name,
            description,
            json.dumps(app.tags),
            row.page.section,
            app.source_version,
            row.sha256,
            int(extracted.truncated),
            extracted.text,
        ),
    )
    connection.executemany(
        'INSERT INTO sections (document_id, position, heading, anchor, level, start, "end") '
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (document_id, position, s.heading, s.anchor, s.level, s.start, s.end)
            for position, s in enumerate(extracted.sections)
        ],
    )
    searchable = (extracted.title or app.name, description, app.name, " ".join(app.tags), extracted.text)
    connection.execute(
        "INSERT INTO search (rowid, title, description, app_name, tags, body) VALUES (?, ?, ?, ?, ?, ?)",
        (document_id, *searchable),
    )
    connection.execute("INSERT INTO words (rowid, body) VALUES (?, ?)", (document_id, "\n".join(searchable)))
