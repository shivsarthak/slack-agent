---
status: accepted
supersedes: 0001-codex-cli-via-exec-and-sdk.md
amends: 0002-unattended-action-boundary.md, 0005-connectors-are-mcp-config.md
---

# Goal-aware approvals through Codex App Server

Ordinary Jobs use one supervised `codex app-server` process over stdio JSON-RPC. Codex
remains the engine and the wrapper's engine port remains protocol-neutral, but `codex exec`
is no longer the Job transport: its non-interactive approval mode cannot pause an exact
action before execution.

In guarded modes the technical baseline is read-only with shell network disabled. Command,
file-change, permission, and configured MCP action paths reach the wrapper before capability
is expanded. The wrapper normalizes that envelope into a Planned Action and the Approval
Gate decides `allow`, `ask`, or `deny` from trusted Goal Context. App Server's session-wide
acceptance variants are never exposed outside the adapter.

`coworker` is the default and permits proven reads plus ordinary bounded work authorized by
the Job. `external-writes` asks for unexempted external mutation. `off` deliberately restores
the previous workspace-write, network-enabled, approval-never behavior; it is an operator
choice, never a fallback after a guarded-mode failure.

Fixed consequence boundaries always ask in guarded modes. Existing disabled MCP tools
remain disabled. Natural-language policy can refine ordinary decisions but cannot weaken
fixed boundaries or explicit ask/deny rules.

When a person is needed, the exact action is held and one Block Kit message is posted in
the Job's Slack Thread. Only the delegator (or Schedule creator) can choose Approve once,
Allow similar in this Thread, or Deny. Similar grants use a deterministic narrow key,
remain Thread-scoped, and persist in wrapper state outside agent-writable paths. Stop,
timeout, engine exit, and restart invalidate pending requests.

## Consequences

- The wrapper is now in the pre-execution permission path, but still does not proxy or
  normalize connector business APIs.
- Approval intent is not outcome evidence. Existing result reporting and Write receipts
  remain responsible for what actually happened.
- Credentials, disabled tools, repository protection, hooks, service authorization, and
  the sandbox remain independent layers.
- App Server protocol drift is an availability failure, not permission to fall back to
  unattended execution. The real-engine contract suite verifies pre-execution blocking.
- Approval waits consume the existing Turn bound and queue slot.

Decided by [the goal-aware approval specification](../../.scratch/goal-aware-approvals/spec.md).
