from pathlib import Path

import pytest
from pydantic import ValidationError

from kb_mcp.config import Settings


def test_reads_kb_mcp_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KB_MCP_INDEX", "/opt/kb/index.sqlite")
    monkeypatch.setenv("KB_MCP_PORT", "9000")
    monkeypatch.setenv("KB_MCP_ALLOWED_ORIGINS", "https://a.example, https://b.example,")
    monkeypatch.setenv("KB_MCP_PUBLIC_ORIGIN", "https://docs.example.com/")

    settings = Settings()

    assert settings.index == Path("/opt/kb/index.sqlite")
    assert settings.port == 9000
    assert settings.allowed_origins == ["https://a.example", "https://b.example"]
    assert settings.public_origin == "https://docs.example.com"


def test_defaults_listen_on_loopback_and_accept_loopback_hosts() -> None:
    settings = Settings()

    assert (settings.host, settings.port, settings.allowed_origins) == ("127.0.0.1", 8081, [])
    assert "127.0.0.1:*" in settings.allowed_hosts


@pytest.mark.parametrize("origin", ["docs.example.com", "ftp://docs.example.com", "https://docs.example.com/kb"])
def test_a_public_origin_must_be_an_origin(monkeypatch: pytest.MonkeyPatch, origin: str) -> None:
    monkeypatch.setenv("KB_MCP_PUBLIC_ORIGIN", origin)

    with pytest.raises(ValidationError, match="origin without a path"):
        Settings()
