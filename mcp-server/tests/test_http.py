"""HTTP behaviour around the MCP endpoint: health, browsers, origins, hosts, bodies."""

import json
from pathlib import Path

import httpx2
import pytest

from kb_mcp.compose import open_knowledge_base
from kb_mcp.config import Settings
from kb_mcp.http import create_app
from kb_mcp.protocol.server import create_server

pytestmark = pytest.mark.anyio

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
}
JSON_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


async def test_health_reports_the_index(http: httpx2.AsyncClient) -> None:
    response = await http.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert len(response.json()["contentHash"]) == 64


async def test_a_browser_opening_the_endpoint_gets_a_page_explaining_it(http: httpx2.AsyncClient) -> None:
    response = await http.get("/mcp?x=<script>")

    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert "MCP client required" in response.text
    assert "<script>" not in response.text


async def test_the_browser_page_names_the_public_endpoint_not_the_upstream(http: httpx2.AsyncClient) -> None:
    response = await http.get("/mcp")

    assert "https://docs.example.com/knowledge-base/mcp" in response.text
    assert "kb.test" not in response.text


async def test_an_agent_without_an_origin_is_served(http: httpx2.AsyncClient) -> None:
    response = await http.post("/mcp", content=json.dumps(INITIALIZE), headers=JSON_HEADERS)

    assert response.status_code == 200
    assert response.json()["result"]["serverInfo"]["name"] == "knowledge-base"


async def test_a_page_from_another_origin_is_refused(http: httpx2.AsyncClient) -> None:
    headers = {**JSON_HEADERS, "Origin": "https://evil.example"}

    response = await http.post("/mcp", content=json.dumps(INITIALIZE), headers=headers)

    assert response.status_code == 403


async def test_an_allowed_origin_gets_a_cors_preflight_answer(http: httpx2.AsyncClient) -> None:
    response = await http.options(
        "/mcp",
        headers={
            "Origin": "https://portal.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, mcp-protocol-version",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://portal.example.com"
    assert "POST" in response.headers["access-control-allow-methods"]


async def test_an_unexpected_host_is_refused(http: httpx2.AsyncClient) -> None:
    headers = {**JSON_HEADERS, "Host": "attacker.test"}

    response = await http.post("/mcp", content=json.dumps(INITIALIZE), headers=headers)

    assert response.status_code == 421


async def test_a_body_that_is_not_json_or_too_large_is_refused(http: httpx2.AsyncClient) -> None:
    wrong_type = await http.post("/mcp", content="x", headers={"Content-Type": "text/plain"})
    too_large = await http.post("/mcp", content="x" * 70_000, headers=JSON_HEADERS)

    assert wrong_type.status_code == 400
    assert too_large.status_code == 413


async def test_without_a_public_origin_the_browser_page_names_the_path(index_path: Path) -> None:
    with open_knowledge_base(Settings(index=index_path)) as kb:
        app = create_app(kb, create_server(kb, "test"), allowed_origins=[], allowed_hosts=["kb.test"])
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://kb.test") as client:
            response = await client.get("/mcp")

    assert "https://&lt;this host&gt;/knowledge-base/mcp" in response.text
