"""A small synthetic site build (dist/ plus its page manifest), and the index built from it."""

import json
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2
import pytest
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client
from starlette.applications import Starlette

from kb_mcp.compose import open_knowledge_base
from kb_mcp.config import Settings
from kb_mcp.http import create_app
from kb_mcp.indexer.build import build_index
from kb_mcp.protocol.server import create_server
from kb_mcp.service import KnowledgeBase

PREFIX = "knowledge-base"


def page_html(body: str, title: str = "Page") -> str:
    """A page as the site build publishes it: the knowledge base masthead, then the sub-app's content."""
    return (
        f"<!doctype html><html><head><title>{title}</title></head><body>"
        '<div class="kb-shell kb-masthead"><a href="/">Knowledge base</a><span>Library</span></div>'
        f"{body}</body></html>"
    )


@dataclass
class Site:
    """Builder for a dist/ directory with dist/_kb/pages.json."""

    root: Path
    apps: list[dict[str, Any]] = field(default_factory=list)
    pages: list[dict[str, Any]] = field(default_factory=list)

    def app(
        self,
        slug: str,
        name: str,
        description: str = "",
        tags: list[str] | None = None,
        *,
        kind: str = "artifact",
        url: str | None = None,
        source_version: str | None = "v1.0.0",
    ) -> Site:
        self.apps.append(
            {
                "slug": slug,
                "name": name,
                "description": description,
                "tags": tags or [],
                "kind": kind,
                "url": url,
                "sourceVersion": source_version,
            }
        )
        return self

    def page(self, app: str, path: str, body: str, *, title: str | None = None, section: str | None = None) -> Site:
        route_path = f"{app}/{path}".strip("/")
        file = f"{route_path}/index.html"
        target = self.root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page_html(body), encoding="utf-8")
        self.pages.append(
            {"app": app, "route": f"/{PREFIX}/{route_path}/", "file": file, "title": title, "section": section}
        )
        return self

    def write(self) -> Path:
        manifest = {"schemaVersion": 1, "pathPrefix": PREFIX, "apps": self.apps, "pages": self.pages}
        (self.root / "_kb").mkdir(parents=True, exist_ok=True)
        (self.root / "_kb" / "pages.json").write_text(json.dumps(manifest), encoding="utf-8")
        return self.root


def default_site(root: Path) -> Site:
    site = Site(root)
    site.app("ops-guide", "Operations Guide", "Running the platform in production.", ["ops", "platform"])
    site.app("dev-handbook", "Developer Handbook", "How we write and ship code.", ["dev"])
    site.app(
        "vendor-docs",
        "Vendor Docs",
        "The vendor's own site.",
        ["external"],
        kind="iframe",
        url="https://vendor.example.com/docs",
        source_version=None,
    )
    site.page(
        "ops-guide",
        "",
        "<main><h1 id='ops'>Operations Guide</h1><p>Everything an on-call engineer needs during an incident.</p>"
        "<h2 id='credentials'>Credentials</h2><p>Rotate passwords for service accounts every ninety days.</p></main>",
    )
    site.page(
        "ops-guide",
        "runbooks/rotation",
        "<main><h1>Password rotation</h1><p>Rotation is automated by the vault. This runbook covers the manual "
        "fallback when the vault is unavailable.</p><h2 id='steps'>Steps</h2><ol><li>Open the vault</li>"
        "<li>Rotate the secret</li></ol></main>",
        title="Password rotation",
        section="Runbooks",
    )
    site.page(
        "ops-guide",
        "messaging",
        "<main><h1>Messaging</h1><p>Services publish domain events on the EventBus, which fans them out to "
        "every subscriber.</p><h2 id='retention'>Retention</h2><p>Events are kept for seven days.</p></main>",
    )
    site.page(
        "dev-handbook",
        "",
        "<main><h1>Developer Handbook</h1><p>Branch from master, open a pull request, and wait for review.</p>"
        "<h2 id='testing'>Testing</h2><p>Every change ships with tests. Deployments happen after review.</p></main>",
    )
    site.page(
        "dev-handbook",
        "style",
        "<main><h1>Code style</h1><p>We format Python with ruff and type-check it with mypy in strict mode.</p></main>",
    )
    site.page("vendor-docs", "", "<main><iframe src='https://vendor.example.com/docs'></iframe></main>")
    return site


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def site(tmp_path: Path) -> Site:
    return default_site(tmp_path / "dist")


@pytest.fixture
def make_index(tmp_path: Path) -> Callable[[Site], Path]:
    def make(site: Site) -> Path:
        out = tmp_path / "index.sqlite"
        build_index(site.write(), out)
        return out

    return make


@pytest.fixture
def index_path(site: Site, make_index: Callable[[Site], Path]) -> Path:
    return make_index(site)


@pytest.fixture
def kb(index_path: Path) -> Iterator[KnowledgeBase]:
    with open_knowledge_base(Settings(index=index_path, public_origin="https://docs.example.com")) as opened:
        yield opened


@pytest.fixture
def app(kb: KnowledgeBase) -> Starlette:
    return create_app(
        kb,
        create_server(kb, "test"),
        allowed_origins=["https://portal.example.com"],
        allowed_hosts=["kb.test"],
    )


@pytest.fixture
async def http(app: Starlette) -> AsyncIterator[httpx2.AsyncClient]:
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://kb.test") as client,
    ):
        yield client


@pytest.fixture
async def client(http: httpx2.AsyncClient) -> AsyncIterator[Client]:
    async with Client(streamable_http_client("http://kb.test/mcp", http_client=http)) as connected:
        yield connected
