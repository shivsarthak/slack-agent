# Hosted Pi Platform — Planning Scratchpad

Planning context only. Do not publish this file or make implementation depend on it.

## Confirmed outcome

Transform open-agent from a single-workspace, self-hosted Slack coworker using Codex App
Server into a multi-tenant hosted platform whose isolated workers use Pi as the agent
harness and whose customers connect an eligible OpenAI account through device-code
authentication during onboarding.

## Confirmed current-state constraints

- Preserve the domain model: Thread, Session, Job, Turn, Vault, Note, Skill, Librarian,
  Progress, Write, Schedule, Occurrence, and Approval Gate.
- Preserve the protocol-neutral `Engine` seam and introduce Pi behind it rather than
  leaking Pi types through the application.
- The existing application is single-instance: one Slack installation, engine, Vault,
  connector registry, environment credential set, local state directory, queue, and
  administrator dashboard.
- Pi supplies programmatic Agent Sessions and OpenAI Codex OAuth, including device-code
  login and credential refresh.
- Pi intentionally supplies no operating-system sandbox. Tenant confidentiality and
  action containment must therefore be external to the Pi process.
- The current Approval Gate depends on exact pre-execution interception. Pi built-in
  mutating tools cannot be enabled as an unmediated path in hosted workers.
- The repository does not yet provide the required executable `./scripts/verify`
  Verification Seam.
- Existing repo instructions describe Local Markdown as the issue tracker, while the
  invoked author-project workflow requires native GitHub issues, sub-issues, dependencies,
  and classifications. Publication destination must be explicitly resolved.

## Approved product and architecture decisions

- A shared control plane owns users, Tenants, Slack installations, OpenAI onboarding,
  encrypted credentials, configuration, durable Jobs, Schedules, approvals, audit data,
  quotas, and worker dispatch.
- V1 is Slack-only. A direct web chat surface is excluded.
- One Tenant is exactly one Slack workspace, one Vault/Skills tree, one configuration, and
  one Tenant-admin-connected OpenAI Codex subscription credential. One customer account may
  own multiple Tenants.
- OpenAI subscription OAuth is the only model billing/authentication path in this Target
  Project. OpenAI Platform API billing and an OpenAI-approval Human Gate are excluded; the
  product authorization question has already been resolved by the owner.
- Slack distribution begins as an unlisted OAuth installation. Marketplace publication is
  excluded.
- An isolated data-plane worker runs a Pi Agent Session for one tenant-scoped Job at a
  time, with only tenant-scoped mounts and credentials.
- PostgreSQL is the transactional system of record and durable Job lease mechanism; Redis
  is excluded initially. Encrypted attached tenant storage holds Vault and Session files;
  object storage holds uploads and result files.
- Slack uses OAuth installations and signed HTTP Events API delivery rather than one
  Socket Mode connection per Tenant.
- The platform disables Pi built-in mutating tools and registers wrapper-owned file,
  command, and connector tools that synchronously consult the existing Approval Gate.
- Existing MCP configuration is adapted to Pi custom tools through the MCP SDK already in
  the repository.
- CodexEngine remains available during migration until PiEngine passes parity and
  isolation checks; migration proceeds by Tenant canary.
- Dashboard authentication uses email magic links with Tenant roles `owner`, `admin`, and
  `member`.
- Billing is excluded. Configurable per-Tenant concurrency and usage quotas are required.
- Existing self-hosted Codex Sessions are not imported. Self-hosted mode remains separately
  usable during migration.
- Docker Compose is the first deployable topology, but control-plane processes are
  stateless, PostgreSQL/object storage are externalizable, Job claiming is lease-based,
  and workers scale horizontally without changing application semantics. Kubernetes or a
  specific hosted orchestrator is excluded from v1.
- Email is behind a provider-neutral port with a development mail sink; the production
  vendor is deployment configuration.
- Object storage uses an S3-compatible interface.
- OAuth and connector credential blobs use versioned AES-256-GCM encryption behind a
  secret-manager-neutral key interface.
- The control plane never receives Docker Engine access. A narrow worker-launcher service
  owns the Docker socket and exposes an allow-listed Unix-socket API.
- Live staging has two Human Gates: Slack install/events/interactions in a test workspace,
  and OpenAI device login/Pi turn/refresh/revocation with an eligible test subscription.
- `./scripts/verify` covers formatting/typechecking, unit and contract tests, database
  migrations, tenant-isolation checks, and local container smoke tests. Live Slack/OpenAI
  checks are staging Human Gates.
- The approved publication target is a native GitHub Project Graph in
  `shivsarthak/slack-agent`, overriding the repository's Local Markdown tracker convention
  for this Target Project.

## Approved dependency-level decisions

- PostgreSQL access uses Drizzle ORM with checked-in SQL migrations.
- Durable Jobs use PostgreSQL `FOR UPDATE SKIP LOCKED`, renewable leases, three attempts
  with exponential backoff, and a terminal dead-letter state.
- Magic links are hashed, single-use, and valid for 15 minutes. Database-backed dashboard
  sessions are valid for seven days.
- The existing repository shape remains: `dashboard/` is the hosted control plane and
  separate worker/launcher entrypoints live under `src/hosted/`.
- Pi Session files live in the Tenant-mounted Session directory. PostgreSQL records engine,
  Session ID, opaque locator, and interrupted state; Pi resumes with
  `SessionManager.open(locator)`.
- Self-hosted `src/index.ts` remains supported. Hosted and self-hosted modes share the same
  domain and Job pipeline and differ only through ports/adapters/stores.
- Hosted Pi enables no built-in filesystem or shell tools. Wrapper-owned read, list, find,
  grep, write, edit, bash, and MCP tools enforce roots and consult policy when applicable.
- Caddy supplies HTTPS and reverse proxying in the first Docker Compose topology and may be
  replaced later by an external load balancer without changing application semantics.

## Open decisions

None. Any material discovery during Slicing returns the project to Wayfinding and requires
a regenerated preview.

## Rejected alternatives so far

- One shared in-process Pi runtime with ambient credentials: rejects tenant isolation.
- Treating Pi `tool_call` extension hooks as the sole security boundary: Pi does not claim
  an OS sandbox, so containment must exist below the harness.
- Directly copying Codex or Pi auth cache files between users: credentials require explicit
  Tenant ownership, encryption, rotation, and revocation.
- Replacing Codex everywhere at once: the existing Engine seam supports a parallel adapter
  and safer canary migration.

## Draft Project Order

1. Executable Verification Seam.
2. Tenant-aware domain and hosted/self-hosted composition.
3. PostgreSQL schema and transactional stores.
4. Dashboard identity and Tenant authorization.
5. Encrypted Tenant configuration and credentials.
6. Slack OAuth installation and signed event ingress.
7. Tenant filesystem and S3 artifact boundaries.
8. Durable Job queue and leases.
9. OpenAI Codex device onboarding through Pi.
10. PiEngine Session/event adapter.
11. Wrapper-owned local tools and Approval Gate bridge.
12. Tenant MCP adapter.
13. Narrow worker-launcher and container policy.
14. Hosted Pi Job worker.
15. Hosted Schedules and Occurrences.
16. Tenant operations dashboard.
17. Usage quotas, audit, and observability.
18. Scalable Docker Compose deployment.
19. Automated release qualification and canary routing.
20. Live Slack staging gate.
21. Live OpenAI/Pi staging gate.
22. Production canary launch gate.
