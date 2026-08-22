#!/bin/sh
# Supervisor for the open-agent process. Run from the repo root.
#
# Writes .state/agent.pid ({"pid":N,"startedAt":ISO}) so the dashboard can
# report liveness and trigger restarts. The agent shuts down cleanly (exit 0)
# on SIGTERM, so "restart" and "stop" are distinguished by a marker file:
# the dashboard touches .state/agent.restart before sending SIGTERM, and the
# loop respawns whenever the marker is present or the agent crashed.
set -u
cd "$(dirname "$0")/.."
mkdir -p .state

cleanup() {
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  rm -f .state/agent.pid .state/agent.restart
  exit 0
}
trap cleanup INT TERM

while :; do
  rm -f .state/agent.restart
  node --env-file-if-exists=.env --experimental-strip-types src/index.ts &
  pid=$!
  printf '{"pid":%d,"startedAt":"%s"}\n' "$pid" "$(date -u +%FT%TZ)" > .state/agent.pid
  wait "$pid"
  code=$?
  if [ -f .state/agent.restart ]; then
    echo "[run-agent] restart requested; respawning" >&2
    continue
  fi
  if [ "$code" -eq 0 ]; then
    break
  fi
  echo "[run-agent] agent exited with code $code; restarting in 2s" >&2
  sleep 2
done
rm -f .state/agent.pid
