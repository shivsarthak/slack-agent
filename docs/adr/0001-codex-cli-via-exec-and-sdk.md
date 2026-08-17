---
status: superseded
superseded_by: 0008-goal-aware-approval-gate.md
---

# Codex CLI as the agent engine, driven via `codex exec` and `@openai/codex-sdk`

**Superseded by [ADR-0008](0008-goal-aware-approval-gate.md).** Codex remains the engine,
but ordinary Jobs now use App Server for a wrapper-owned approval round trip. This file
records the former decision and rationale.

The coworker needs an agent that can be delegated a task from a Slack thread and left to work for minutes or hours. We use **OpenAI's Codex CLI** as that engine, driven headlessly through **`codex exec`** via the **`@openai/codex-sdk`** TypeScript SDK, rather than the `app-server` JSON-RPC interface. Codex is open source, locally installed, filesystem-native (an Obsidian vault is just files it already reads and writes) and an MCP client, which matches a self-hosted product whose users supply their own credentials. `exec` was chosen over `app-server` because the product decision is that the coworker **does not stop to ask permission** — it runs commands, calls APIs, and opens pull requests unattended — and `exec` hard-codes exactly that (`approval_policy: Never`) on the stable, Apache-2.0, TypeScript-native path, whereas `app-server`'s only decisive advantage was the approval round-trip we do not want.

## Considered options

- **Claude Agent SDK / Messages API tool-runner / a manual loop** — rejected in favour of Codex CLI, which the project owner chose directly.
- **`codex app-server` / `mcp-server`** — offers approvals as server→client requests, delta streams, `turn/steer` and `turn/interrupt`, and `dynamicTools` (connectors as in-process TypeScript functions). Rejected: its protocol is documented as experimental and subject to change without notice, against a project shipping multiple alpha releases per day, and its headline capability is one v1 explicitly does not want.

## Consequences

- **The token is the permission model.** With no approval gate and untrusted input flowing in from Slack, GitHub, and Linear, the only bounds on the agent are credential scoping, sandbox mode, `execpolicy`, and per-MCP-server `disabled_tools`. The Codex sandbox governs filesystem and network, **not intent** — nothing distinguishes reading a pull request from merging one.
- **Progress is item-level, not token-level.** `codex exec --json` emits typed events but deliberately drops all deltas. This suits Slack's rate limits, and the two-minute `assistant.threads.setStatus` timeout is satisfied without deltas.
- **Durability is turn-granular.** Sessions resume via `codex exec resume`, but a crash mid-turn cannot resume that turn. Side-effect reconciliation on retry is the wrapper's problem.
- **Mid-turn steering is unavailable**; hard-stop is not, since the wrapper owns the subprocess.
- **"Bring your own model" is effectively unavailable.** `WireApi` has one variant, `Responses`; Chat Completions was removed. Any alternative backend must serve an OpenAI Responses API — a real constraint to document up front for a self-hosted open-source tool.
- **Connectors are MCP**, not in-process functions, since `dynamicTools` is `app-server`-only.
- **The Codex version must be pinned.** Flags this project would plausibly have depended on (`--full-auto`, `wire_api = "chat"`, `ollama-chat`) have already been removed.
- **Keep Codex behind an adapter seam** — one module owning process lifecycle, event translation, and session identity — so a later move to `app-server` is a bounded rewrite rather than a spreading change.

Decided in [ticket 01](../../.scratch/slack-coworker/issues/01-agent-engine.md) and [ticket 11](../../.scratch/slack-coworker/issues/11-codex-interface.md); evidence in [`research/codex-cli-surface.md`](../../.scratch/slack-coworker/research/codex-cli-surface.md).
