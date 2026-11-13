# syntax=docker/dockerfile:1.10
#
# The MCP server image: the Python server plus the search index built from one
# site build. The site image (../Dockerfile) and this one are built from the same
# dist/ and run side by side in one task; nginx in the site image proxies
# /knowledge-base/mcp to 127.0.0.1:8081. See docs/adr/0001-mcp-server.md.
#
# Build from the repository root, after the site build has written dist/:
#
#   docker build -f mcp-server/Dockerfile -t knowledge-base-mcp .
#
# Dockerfile.dockerignore next to this file limits the context to dist/, this
# project and trusted_certs/.

FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv

# Pinned by digest like every other base image; Dependabot bumps tag and digest.
FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
# Behind a TLS-intercepting proxy the package mirror's certificate is signed by
# the proxy's CA. Same mechanism as the site image: every *.pem/*.crt in
# trusted_certs/ (or TRUSTED_SSL_CERTS) joins the system bundle, which uv uses
# with UV_SYSTEM_CERTS.
ARG TRUSTED_SSL_CERTS=./trusted_certs
COPY $TRUSTED_SSL_CERTS /opt/certs/
RUN for CERT_PATH in /opt/certs/*.pem /opt/certs/*.crt; do \
      [ -e "$CERT_PATH" ] || continue; \
      { cat "$CERT_PATH"; echo; } >> /etc/ssl/certs/ca-certificates.crt; \
    done

# ── Install: two virtual environments from the lockfile ──────────────────────
# uv.lock records PyPI's URLs, and `uv sync --locked` refuses any other index.
# The exported requirements carry versions and hashes but no URL, so the same
# lockfile installs from PyPI or from the mirror the `python-index` secret names
# (a URL, credentials included when the mirror needs them; never in a layer).
FROM base AS install
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_SYSTEM_CERTS=1 \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy
WORKDIR /build
COPY mcp-server/pyproject.toml mcp-server/uv.lock ./
COPY mcp-server/src ./src
RUN uv export --quiet --frozen --no-dev --no-emit-project -o requirements.txt \
 && uv export --quiet --frozen --no-dev --no-emit-project --extra indexer -o requirements-indexer.txt
RUN --mount=type=secret,id=python-index,env=UV_DEFAULT_INDEX \
    for VENV in runtime:requirements.txt indexer:requirements-indexer.txt; do \
      uv venv "/opt/${VENV%%:*}" \
      && VIRTUAL_ENV="/opt/${VENV%%:*}" uv pip install --require-hashes --no-deps -r "${VENV#*:}" \
      && VIRTUAL_ENV="/opt/${VENV%%:*}" uv pip install --no-deps . ; \
    done

# ── Index: the site build, reduced to one SQLite file ────────────────────────
FROM install AS index
COPY dist /dist
RUN test -f /dist/_kb/pages.json \
 || (echo "dist/ has no _kb/pages.json — run the site build (npm run build:headless) first" >&2; exit 1)
RUN /opt/indexer/bin/kb-mcp index --dist /dist --out /index.sqlite

# ── Runtime: the server and its index, nothing else ──────────────────────────
FROM base AS runtime
RUN useradd --no-create-home --uid 10001 --shell /usr/sbin/nologin kb-mcp
COPY --from=install /opt/runtime /opt/runtime
COPY --from=index /index.sqlite /srv/kb-mcp/index.sqlite
ENV PATH=/opt/runtime/bin:$PATH \
    KB_MCP_INDEX=/srv/kb-mcp/index.sqlite \
    KB_MCP_HOST=127.0.0.1 \
    KB_MCP_PORT=8081
USER 10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=3)"]
CMD ["kb-mcp", "serve"]
