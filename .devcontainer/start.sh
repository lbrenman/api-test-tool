#!/usr/bin/env bash
# Runs on every Codespace start: make port 3000 public (so external callers and webhooks can reach it)
# and start the server in the background. Logs: /tmp/api-test-tool.log
set -u
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env

if [ -n "${CODESPACE_NAME:-}" ]; then
  # The port must exist before its visibility can be changed; retry in the background for a while.
  ( for i in $(seq 1 30); do
      gh codespace ports visibility 3000:public -c "$CODESPACE_NAME" >/dev/null 2>&1 && echo "[start] port 3000 is public" && break
      sleep 2
    done ) &
fi

if ! pgrep -f "node src/server.js" >/dev/null; then
  nohup node src/server.js > /tmp/api-test-tool.log 2>&1 &
  echo "[start] server starting — tail -f /tmp/api-test-tool.log"
fi

if [ -n "${CODESPACE_NAME:-}" ]; then
  echo "[start] dashboard: https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/dashboard"
fi
