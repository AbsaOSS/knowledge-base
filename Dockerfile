# Node runtime donor. Only binary and Alpine C++ runtime libraries are copied; no apk/npm run here.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node-runtime

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime
USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node-runtime /usr/lib/libgcc_s.so.1 /usr/lib/
RUN node --version
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx.headers.conf /etc/nginx/kb-headers.conf
COPY dist /usr/share/nginx/html
RUN test -f /usr/share/nginx/html/index.html \
 || (echo "dist/ has no index.html — run 'npm run build:headless' before docker build" >&2; exit 1)
RUN test -f /usr/share/nginx/html/style.css \
 || (echo "dist/ has no style.css — sub-app pages reference it via /__wf/knowledge-base/style.css" >&2; exit 1)
# Runtime corpus is not static public content.
RUN test -f /usr/share/nginx/html/_mcp/server.mjs && test -f /usr/share/nginx/html/_mcp/corpus.json \
 || (echo "dist/_mcp missing — run the knowledge-base build (step 3b) before docker build" >&2; exit 1) \
 && mkdir -p /opt/kb-mcp && mv /usr/share/nginx/html/_mcp/* /opt/kb-mcp/ && rmdir /usr/share/nginx/html/_mcp
COPY docker/kb-entrypoint.sh /usr/local/bin/kb-entrypoint.sh
RUN chmod 0755 /usr/local/bin/kb-entrypoint.sh
USER 101
ENV KB_MCP_HOST=127.0.0.1 KB_MCP_PORT=8081 KB_MCP_CORPUS=/opt/kb-mcp/corpus.json NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null && wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["/usr/local/bin/kb-entrypoint.sh"]
