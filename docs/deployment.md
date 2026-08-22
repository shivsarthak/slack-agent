# Docker Compose deployment

`compose.yaml` is the first hosted topology. It runs Caddy, the stateless dashboard/control
plane, PostgreSQL, MinIO-compatible object storage, Mailpit, the one-shot migrator, the
Docker-isolated worker launcher, and horizontally scalable workers.

## Configure

Copy `deploy/compose.env.example` to `.env` and replace every `change-me` value before
using the topology anywhere except an isolated local machine. Keep `.env` out of source
control and restrict it to the deployment account. `DATABASE_URL`, S3, SMTP, and internal
service addresses are derived inside Compose; an external PostgreSQL, S3, or SMTP service
can replace the corresponding Compose service without changing application semantics.

Create the host directories before startup:

```sh
sudo install -d -m 0750 /srv/open-agent/tenants
```

On Docker Desktop, set `TENANTS_ROOT` to an absolute path in a shared directory. The path
is intentionally identical on the host and in the launcher because Docker Engine resolves
a launched worker's bind sources on the host.

The private `launcher-socket` volume contains runtime IPC and ephemeral credential files,
not application state. PostgreSQL is the transactional system of record, MinIO owns
artifacts, and the two Caddy volumes own its local CA/config.
Back up the named `postgres-data` and `object-storage-data` volumes. The control plane and
workers have no replica-local durable volume.

## Start, migrate, and scale

```sh
docker compose config --quiet
docker compose up --build --wait
docker compose up -d --scale control-plane=2 --scale worker=4
curl --fail --insecure https://localhost:8443/health
```

The one-shot `migrate` service uses a PostgreSQL advisory lock, so concurrent deploys are
safe and edited migration history is refused. Control-plane and worker replicas start only
after it exits successfully. Long-running services have health checks, run under an init
process, receive `SIGTERM`, and use bounded shutdown grace periods.

Caddy uses its internal CA for local HTTPS. For a VPS, set `AUTH_ORIGIN`, publish ports 80
and 443, and replace `:443` in `deploy/Caddyfile` with the real hostname. DNS and public
certificate ownership remain operator responsibilities.

Only `worker-launcher` mounts `/var/run/docker.sock`. It exposes the allow-listed Unix
socket at `/run/open-agent/launcher.sock`; neither the control plane nor workers receive
Docker Engine access. Treat launcher compromise as host compromise and do not add the
Docker socket to another service.

Run `./scripts/verify` before deployment. Its deployment stages validate health gates,
migration ordering, replica safety, concurrent queue/worker behavior, and Docker isolation.
