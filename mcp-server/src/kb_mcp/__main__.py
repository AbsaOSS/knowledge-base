"""`kb-mcp index` builds the search index from a site build; `kb-mcp serve` serves it."""

import argparse
import logging
import sys
from importlib.metadata import version
from pathlib import Path

import uvicorn

from kb_mcp.compose import open_knowledge_base
from kb_mcp.config import Settings
from kb_mcp.http import create_app
from kb_mcp.protocol.server import create_server


def _index(args: argparse.Namespace) -> int:
    # Imported here: the runtime image installs without the indexer's HTML parser.
    from kb_mcp.indexer.build import build_index  # noqa: PLC0415

    stats = build_index(args.dist, args.out)
    print(f"Indexed {stats.documents} document(s) from {stats.apps} app(s) into {args.out}")  # noqa: T201
    return 0


def _serve(_: argparse.Namespace) -> int:
    settings = Settings()
    with open_knowledge_base(settings) as kb:
        app = create_app(
            kb,
            create_server(kb, version("kb-mcp")),
            allowed_origins=settings.allowed_origins,
            allowed_hosts=settings.allowed_hosts,
        )
        uvicorn.run(
            app,
            host=settings.host,
            port=settings.port,
            limit_concurrency=settings.max_concurrency,
            log_level=settings.log_level,
            server_header=False,
            proxy_headers=False,
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kb-mcp", description=__doc__)
    commands = parser.add_subparsers(required=True)

    index = commands.add_parser("index", help="build the search index from a site build's dist/")
    index.add_argument("--dist", type=Path, default=Path("dist"), help="the site build (default: dist)")
    index.add_argument("--out", type=Path, default=Path("index.sqlite"), help="the index file to write")
    index.set_defaults(run=_index)

    serve = commands.add_parser("serve", help="serve the index over MCP (settings: KB_MCP_* variables)")
    serve.set_defaults(run=_serve)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    return int(args.run(args))


if __name__ == "__main__":
    sys.exit(main())
