"""The ASGI application: the MCP endpoint, a health check, and a page for browsers that open the endpoint.

Generic HTTP protection (rate limits, timeouts) is nginx's; the SDK checks Host, Origin, Content-Type
and body size; uvicorn caps concurrency.
"""

import contextlib
from collections.abc import AsyncIterator
from html import escape

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Mount, Route

from kb_mcp.service import KnowledgeBase

MCP_PATH = "/mcp"
MAX_BODY_BYTES = 64 * 1024
MCP_HEADERS = ["Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name"]

_BROWSER_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP client required</title></head>
<body>
<h1>MCP client required</h1>
<p>This is the Knowledge Base's Model Context Protocol endpoint. Add it to an MCP client, for example:</p>
<pre>claude mcp add --transport http knowledge-base {url}</pre>
</body>
</html>
"""


def create_app(
    kb: KnowledgeBase, server: MCPServer, *, allowed_origins: list[str], allowed_hosts: list[str]
) -> Starlette:
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=allowed_hosts, allowed_origins=allowed_origins
    )
    mcp_app = server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=security,
        max_request_body_size=MAX_BODY_BYTES,
    )

    async def health(_: Request) -> JSONResponse:
        info = kb.info()
        return JSONResponse({"status": "ok", "indexedAt": info.indexed_at, "contentHash": info.content_hash})

    async def browser_page(request: Request) -> HTMLResponse:
        url = escape(str(request.url.replace(query=None, fragment=None)))
        return HTMLResponse(_BROWSER_PAGE.format(url=url), status_code=405, headers={"Allow": "POST"})

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        # Starlette never runs a mounted application's lifespan, so the SDK's session manager starts here.
        async with server.session_manager.run():
            yield

    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_methods=["POST"],
            allow_headers=MCP_HEADERS,
            max_age=600,
        )
    ]
    return Starlette(
        routes=[
            Route("/healthz", health, methods=["GET"]),
            Route(MCP_PATH, browser_page, methods=["GET"]),
            Mount("/", app=mcp_app),
        ],
        middleware=middleware,
        lifespan=lifespan,
    )
