#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

project="open-agent-smoke-$$"
smoke_root=$(mktemp -d /tmp/open-agent-smoke.XXXXXX)
mkdir -p "$smoke_root/tenants" .test-tmp/buildx

cleanup() {
  TENANTS_ROOT="$smoke_root/tenants" HTTP_PORT=0 HTTPS_PORT=0 \
    docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$smoke_root"
}
trap cleanup EXIT INT TERM

export BUILDX_CONFIG=$PWD/.test-tmp/buildx
export TENANTS_ROOT=$smoke_root/tenants
export HTTP_PORT=0
export HTTPS_PORT=0

docker compose -p "$project" build
docker compose -p "$project" up -d --wait --scale control-plane=2 --scale worker=2

[ "$(docker compose -p "$project" ps -q control-plane | wc -l | tr -d ' ')" = 2 ]
[ "$(docker compose -p "$project" ps -q worker | wc -l | tr -d ' ')" = 2 ]
[ "$(docker inspect "${project}-migrate-1" --format '{{.State.ExitCode}}')" = 0 ]

https_port=$(docker compose -p "$project" port caddy 443 | sed 's/.*://')
curl --fail --silent --show-error --insecure "https://localhost:$https_port/health" \
  | grep -q '"status":"ready"'

printf '[deployment:smoke] topology healthy behind HTTPS with two control planes and two workers\n'
