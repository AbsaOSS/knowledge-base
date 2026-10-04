#!/bin/sh
# Runs MCP loopback process and nginx; either exit stops container for ECS.
set -u
node /opt/kb-mcp/server.mjs --http --host "${KB_MCP_HOST}" --port "${KB_MCP_PORT}" --corpus "${KB_MCP_CORPUS}" &
NODE_PID=$!
nginx -g 'daemon off;' &
NGINX_PID=$!
term() { kill -TERM "$NODE_PID" 2>/dev/null; kill -QUIT "$NGINX_PID" 2>/dev/null; wait; exit 0; }
trap term TERM INT
while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do sleep 2; done
echo "kb-entrypoint: a process exited (node=$NODE_PID nginx=$NGINX_PID); stopping container" >&2
kill -TERM "$NODE_PID" 2>/dev/null; kill -QUIT "$NGINX_PID" 2>/dev/null
wait
exit 1
