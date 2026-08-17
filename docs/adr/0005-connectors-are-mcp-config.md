---
status: accepted
---

# Connectors are MCP servers in configuration — there is no plugin interface

**Amended by [ADR-0008](0008-goal-aware-approval-gate.md): the wrapper is now in the
pre-execution approval path.** It still does not proxy or normalize connector business APIs;
App Server supplies a normalized approval envelope before configured calls execute.

**Amended by [ADR-0007](0007-github-is-an-official-mcp-server.md): the GitHub carve-out is removed.**
GitHub's official MCP server now uses this same interface. The superseded Skill-over-`gh`
design in ADR-0006 never reached a working Job path and duplicated configuration,
authentication, audit, and preflight machinery.

**Amended 2026-07-30: MCP calls no longer create separate Slack receipt messages.**
Relevant outcomes belong in the Job's final answer; routine connector reads should not
add chatter to the Thread.

**Amended 2026-07-29: all MCP servers now live in one project-owned `mcp.json`.** MCP and
its TypeScript SDK do not define a portable host configuration format, so the file is not
presented as an MCP standard. It is a small validated seam that supports the specification's
two transports—Streamable HTTP and stdio—and translates the same entries into Codex
configuration. Preflight now uses the official `@modelcontextprotocol/client` v2 SDK rather
than maintaining a parallel implementation of initialization, sessions, SSE parsing, and
pagination. Optional exact-name exclusions remain beside each server because they are
open-agent policy, not transport configuration. Tool inventories are intentionally not
pinned: additions and removals do not prevent startup. Research:
[`mcp-typescript-sdk-client-config.md`](../../.scratch/slack-coworker/research/mcp-typescript-sdk-client-config.md).

"Connect it to various apps" is delivered by pointing Codex at MCP servers, not by a
connector API this project defines. The wrapper now sees App Server's pre-execution
approval envelope but still does not proxy the call. Normalizing connector business APIs
would have to lie: GitHub's binary `open`/`closed` differs from Linear's team-scoped
`WorkflowState`, and their project, comment, and upsert semantics do not form one honest
portable surface. A capable model is better served by each service's real vocabulary.

## Consequences

- **Third-party extension is "point it at an MCP server"** — no interface to author, version, or document, and the ecosystem does the work.
- **Both Streamable HTTP and stdio are supported.** Credentials stay as per-server
  environment-variable references; stdio commands are executable software and receive a
  startup warning.
- **Codex Apps are disabled for Jobs.** Apps/connectors are enabled by default in Codex and
  use authorizations outside this registry. The generated engine configuration sets
  `features.apps = false`, so a Job sees only the MCP servers explicitly named here.
- **The [ADR-0002](0002-unattended-action-boundary.md) deny-list is Codex config**
  (`disabled_tools` per server), not wrapper enforcement.
- **Argument-level constraints are structurally unavailable.** Nothing can inspect the arguments to Linear's `save_issue` to distinguish creating from overwriting. Already accepted in ADR-0002; now a property of the architecture rather than a choice.
- **Connector inventories are live and may evolve.** Preflight reports the current count
  for visibility but does not require an operator to approve changes.
- **Git stays outside MCP:** a checkout costs no new connector and the API can neither grep
  nor run tests, so the seam is git for the filesystem and MCP for GitHub metadata,
  issues, reviews, and pull requests.
- **Branch-protection verification is not a connector carve-out.** Build/10 makes three
  read-only GitHub REST requests at startup because the effective-rules and bypass fields
  ADR-0002 requires are not exposed by the MCP toolsets. Jobs receive no such client; their
  GitHub work remains entirely MCP plus local git.
- Posting to the Thread is the wrapper's job via the event stream, and the Vault is the filesystem — neither needs a tool.

Decided in [ticket 07](../../.scratch/slack-coworker/issues/07-connector-interface.md); inventories measured in [ticket 05](../../.scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md).
