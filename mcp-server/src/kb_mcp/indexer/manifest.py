"""The page manifest the site build writes to `dist/_kb/pages.json`.

Its JSON Schema is `scripts/page-manifest.schema.json` in the repository root; this model
accepts exactly what it allows, so a manifest from a newer build fails here instead of being
indexed wrongly.
"""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MANIFEST_PATH = Path("_kb") / "pages.json"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ManifestApp(_Strict):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str
    description: str
    tags: list[str]
    kind: Literal["artifact", "iframe"]
    url: str | None
    source_version: str | None = Field(alias="sourceVersion")


class ManifestPage(_Strict):
    app: str
    route: str = Field(pattern=r"^/[a-z0-9-]+/.+/$")
    file: str
    title: str | None
    section: str | None

    @field_validator("file")
    @classmethod
    def _inside_dist(cls, file: str) -> str:
        if file.startswith("/") or ".." in file.split("/") or not file.endswith("/index.html"):
            raise ValueError("must be a relative path under dist/ ending in /index.html")
        return file


class PageManifest(_Strict):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    path_prefix: str = Field(alias="pathPrefix", pattern=r"^[a-z0-9-]+$")
    apps: list[ManifestApp]
    pages: list[ManifestPage]

    def app(self, slug: str) -> ManifestApp | None:
        return next((app for app in self.apps if app.slug == slug), None)

    def path_within_app(self, page: ManifestPage) -> str:
        """The route below `/<prefix>/<app>/`, without slashes at either end; empty for the app's root."""
        prefix = f"/{self.path_prefix}/{page.app}/"
        if not page.route.startswith(prefix):
            raise ValueError(f"Route {page.route} is not under {prefix}")
        return page.route.removeprefix(prefix).strip("/")


def load_manifest(dist: Path) -> PageManifest:
    path = dist / MANIFEST_PATH
    if not path.is_file():
        raise FileNotFoundError(f"No page manifest at {path}; build the site first")
    return PageManifest.model_validate_json(path.read_bytes())
