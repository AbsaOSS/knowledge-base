"""Every document as a `kb://` resource.

The index is immutable for the life of the process, so the resources are registered once at
startup. The SDK does not paginate `resources/list`; `list_documents` is the paginated way to
browse a large knowledge base.
"""

from collections.abc import Callable

from mcp.server import MCPServer
from mcp.server.mcpserver.resources.types import FunctionResource

from kb_mcp.service import KnowledgeBase


def register_resources(server: MCPServer, kb: KnowledgeBase) -> None:
    for document in kb.all_documents():
        server.add_resource(
            FunctionResource(
                uri=document.uri,
                name=document.uri,
                title=document.title,
                description=document.description,
                mime_type="text/markdown",
                fn=_reader(kb, document.uri),
            )
        )


def _reader(kb: KnowledgeBase, uri: str) -> Callable[[], str]:
    return lambda: kb.resource_text(uri)
