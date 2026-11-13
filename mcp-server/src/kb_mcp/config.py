"""Server settings, from `KB_MCP_*` environment variables. The only code that reads the environment."""

from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KB_MCP_", frozen=True)

    index: Path = Path("index.sqlite")
    """The SQLite search index `kb-mcp index` wrote."""
    host: str = "127.0.0.1"
    port: int = Field(default=8081, ge=0, le=65_535)
    public_origin: str | None = None
    """`https://host` the site is served from; when set, results carry absolute links."""
    allowed_origins: Annotated[list[str], NoDecode] = []
    """Browser origins allowed to call the endpoint. Requests without an Origin (agents) always pass."""
    allowed_hosts: Annotated[list[str], NoDecode] = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    """Host headers accepted (DNS rebinding protection). nginx forwards the upstream address."""
    max_concurrency: int = Field(default=32, ge=1)
    """Requests handled at once; beyond it the server answers 503."""
    log_level: str = "info"

    @field_validator("allowed_origins", "allowed_hosts", mode="before")
    @classmethod
    def _comma_separated(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("public_origin")
    @classmethod
    def _origin_only(cls, value: str | None) -> str | None:
        if not value:
            return None
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/") or parts.query:
            raise ValueError("must be an http(s) origin without a path, e.g. https://docs.example.com")
        return f"{parts.scheme}://{parts.netloc}"
