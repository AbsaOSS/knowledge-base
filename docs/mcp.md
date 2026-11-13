# The knowledge base MCP server

AI agents can search and read the knowledge base over the
[Model Context Protocol](https://modelcontextprotocol.io). The endpoint serves exactly what the site
serves, read-only, from a search index built with the site.

- Deploying it: [contract/DEPLOYMENT.md](../contract/DEPLOYMENT.md#the-mcp-server)
- Developing it: [mcp-development.md](mcp-development.md)
- Why it is built this way: [adr/0001-mcp-server.md](adr/0001-mcp-server.md)

## Connecting an agent

The endpoint is `/knowledge-base/mcp` on the site's own host, over Streamable HTTP. It needs no
authentication and keeps no session.

```sh
# Claude Code
claude mcp add --transport http knowledge-base https://docs.example.com/knowledge-base/mcp
```

Clients configured with JSON (VS Code, Cursor, Claude Desktop and others) take the same URL:

```json
{
  "servers": {
    "knowledge-base": { "type": "http", "url": "https://docs.example.com/knowledge-base/mcp" }
  }
}
```

Opening the URL in a browser shows a short page saying so; MCP clients `POST` to it.

## What an agent gets

**Tools** (all read-only):

| Tool | Does |
|---|---|
| `search_documents` | Ranked full-text search across every app. Tolerates misspellings and split or joined compound words. Each hit names the section to link to and carries an excerpt. Paginated with a cursor. |
| `list_documents` | Browse: every document, filterable by app, tag and title. Paginated with a cursor. |
| `read_document` | A document's text, a slice at a time (`offset`, `max_chars`), for documents too long to read at once. |

Every result carries the document's `kb://` URI (what `read_document` takes), its app, its route on
the site and — when the deployment sets `KB_MCP_PUBLIC_ORIGIN` — an absolute link a person can open.

**Resources:** every page as `kb://<app>/<path>` (`text/markdown`), headed by its title, app and
link.

**Instructions:** the server tells the agent which apps the knowledge base holds, so it can decide
when searching it is worth a call.

## Operating it

The MCP server is a second container beside the site container in one task. nginx in the site
container proxies `/knowledge-base/mcp` to it on `127.0.0.1:8081`; nothing else reaches it.

### Health

- `GET /healthz` on the MCP container (its Docker `HEALTHCHECK` uses it) answers
  `{"status": "ok", "indexedAt": …, "contentHash": …}`. `contentHash` changes exactly when the
  indexed content does, so it tells which build a running container serves.
- The site container's own `/healthz` does not depend on the MCP container: a site without it keeps
  serving every page.

### Settings

See [contract/DEPLOYMENT.md](../contract/DEPLOYMENT.md#settings): `KB_MCP_PUBLIC_ORIGIN`,
`KB_MCP_ALLOWED_ORIGINS`, `KB_MCP_MAX_CONCURRENCY`, `KB_MCP_LOG_LEVEL`.

### Limits

| Limit | Where | Answer |
|---|---|---|
| 20 requests/s per client (burst 40), 200/s in total (burst 400) | nginx | `429` |
| Request body over 64 KiB | nginx, then the server | `413` |
| More than `KB_MCP_MAX_CONCURRENCY` requests at once | the server | `503` |
| A browser page from an origin not in `KB_MCP_ALLOWED_ORIGINS` | the server | `403` |
| A `Host` other than the loopback upstream | the server | `421` |
| Upstream slower than 30 s, or not running | nginx | `504` / `502` |

Inputs are bounded too: a search query is at most 200 characters, a page of results at most 25
(search) or 100 (list), a read at most 50 000 characters.

### Updating the content

The index is built into the image, from the same `dist/` as the site image. New content means a new
build of both images and a deployment of both, at the same tag. There is nothing to migrate and no
state to keep: a container is replaced, never updated.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `502` from `/knowledge-base/mcp` | The MCP container is not running in the same task, or not yet healthy. Check the task definition (`dependsOn` … `HEALTHY`) and the container's log. |
| `403` for every call from a browser-based client | Its origin is not in `KB_MCP_ALLOWED_ORIGINS`. Agents that send no `Origin` are unaffected. |
| `421 Misdirected Request` | Something in front rewrote the `Host` header to the public one on the hop to the MCP container. nginx must keep the upstream's own (`proxy_pass` without `proxy_set_header Host`). |
| `429` under normal use | Several clients share one address the limit sees — the load balancer's, because it is not in a private range nginx trusts for `X-Forwarded-For`. |
| Results link to `/knowledge-base/…` routes, not full URLs | `KB_MCP_PUBLIC_ORIGIN` is not set. |
| Search misses a page the site shows | The MCP image is from a different build than the site image. Compare `contentHash` on the MCP `/healthz` across the two deployments, and deploy both images at the same tag. |
| The MCP container exits at start with `IndexUnavailableError` | The image's index is missing or from an incompatible version — the image was not built by `mcp-server/Dockerfile`, or `KB_MCP_INDEX` was overridden. |
