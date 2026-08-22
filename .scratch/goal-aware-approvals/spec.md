# PRD: Goal-aware approval gate

Status: ready-for-agent

## Problem Statement

Open-agent is meant to behave like a coworker: a person delegates a complete task in a
Slack Thread, walks away, and expects the Job to finish. The current engine path uses Codex
non-interactively with approvals disabled. That makes delegation smooth, but it also means
that a Job can cross an important consequence boundary without stopping. A real incident
demonstrated the gap: when one GitHub path was unavailable, the agent used ordinary shell
commands to push and create a pull request without asking. A tool-specific block or command
shim would not solve the general problem because the same outcome may be reachable through
another executable, direct HTTP, an MCP tool, a database client, or a future connector.

Asking before every command is also not acceptable. It would turn the coworker back into an
assistant that must be babysat and would make routine reads, edits, tests, feature-branch
pushes, ticket updates, and other expected work counterproductive to delegate.

The missing capability is a reusable approval gate like the policy layer in an agent
harness. It must use the initial Job request and trusted Thread context as authorization,
let ordinary bounded work continue silently, and pause in Slack only when an exact planned
action is consequential, broader than the delegated goal, explicitly configured to require
approval, or not understood well enough to classify safely.

This is a change to the product's action boundary. It contradicts the parts of the existing
engine and unattended-action decisions that deliberately chose `codex exec` and approvals
off. Those decisions must be superseded explicitly rather than silently worked around.

## Solution

Add a goal-aware **Approval Gate** between Codex and every action that can cross the Job's
ordinary bounded environment. Migrate the engine adapter from non-interactive `codex exec`
to Codex App Server over its stdio JSON-RPC protocol so the wrapper receives a request
before command execution, file changes, permission grants, and configured MCP tool calls.

The default mode is `coworker`. In this mode, proven reads and ordinary, reversible,
bounded actions that clearly advance the delegated Job proceed without a Slack prompt.
The gate asks in Slack only at a **Consequence Boundary**: production changes, merges,
destructive or bulk operations, security and access changes, sensitive egress, unexpected
external communication, actions materially outside the Job's goal, and unknown actions.

The operator may choose one of three modes:

- `off`: preserve today's unattended behavior and show no approval prompts;
- `coworker`: the default goal-aware behavior described above; or
- `external-writes`: a stricter baseline that asks before every Write to a shared or
  external system while still allowing reads and authorized local work automatically;
  explicit operator allows and narrow Thread Grants may exempt a specific class.

There is deliberately no `all-writes` mode. Asking about every local edit is incompatible
with the coworker product. Operators who need an agent that cannot edit should use a
read-only capability boundary rather than an approval setting for this product.

When human approval is needed, the Job posts one Slack Block Kit message in its Thread with
an exact summary and three buttons:

- **Approve once** — allow only the pending planned action;
- **Allow similar in this Thread** — allow the pending action and persist a narrowly
  normalized Thread Grant for later matching actions; and
- **Deny** — refuse the planned action and return the reason to the agent so it can choose a
  materially safer path or report that it cannot continue.

The operator may also provide a trusted natural-language policy. That policy fine-tunes
what routine actions the `coworker` mode may perform without asking. It may allow actions
that the mode would otherwise conservatively ask about, or require approval for actions the
mode would ordinarily allow. It never overrides the hard forbidden floor or a fixed
Consequence Boundary that this PRD says always requires human approval.

The gate is not merely a prompt. Enforcement comes from putting mutation and network
boundaries behind App Server approval requests, requiring all MCP calls to pass through an
approval request before execution, refusing broad session permission grants, and retaining
credential scoping and server-side protections as independent layers.

## Goals and Principles

1. A person should normally assign one task and receive the completed result without being
   asked about implementation details.
2. The initial Job request is authorization for ordinary necessary steps whose target,
   scope, audience, environment, and effects match that request.
3. Authorization for a broad goal is not authorization for a broader target, a different
   audience, destructive cleanup, production impact, sensitive disclosure, paid action,
   access change, or security-control bypass.
4. Reads that are proven to be read-only should not create Slack prompts.
5. Unknown actions require approval.
6. Tool outputs, repository content, issue comments, web pages, database contents, and other
   retrieved material are evidence, not authorization.
7. Approval must apply to the exact pending action. Approval of one action must not silently
   open a path for a different future action.
8. The same policy must cover shell commands, MCP tools, database operations, and future
   integrations. No service-specific approval system is introduced.
9. The current `off` behavior remains available as an explicit operator choice.
10. The feature should be simpler than a full general-purpose policy language. Modes,
    narrow deterministic rules, a natural-language policy, and Thread Grants are enough.

## Domain Model

The existing canonical meanings of Thread, Session, Job, Turn, Progress, and Write continue
to apply.

### Approval Gate

The wrapper-owned component that receives a Planned Action, evaluates policy, and resolves
it as `allow`, `ask`, or `deny` before execution. It is the only component allowed to answer
App Server approval requests for ordinary Jobs.

### Planned Action

One exact operation that has not executed yet. It includes its source, target, arguments,
working directory or remote scope, requested permissions, and the App Server response
handle required to resume or decline it. A Planned Action may represent a command, file
change, network request, permission request, or MCP tool call.

### Goal Context

The trusted authorization context for the current decision. It consists of the current
Job's original Slack request, trusted human messages already present in that Thread's
Session, the operator policy, the active mode, and wrapper-known scope such as repository,
workspace, Schedule, or environment. The raw request remains available; a model-generated
summary must never replace it as the source of authorization.

For a Scheduled Job, the Schedule's stored task is the original request and the Schedule
creator is the delegator. Retrieved content and agent-authored text cannot broaden Goal
Context.

### Effect

The gate's classification of what an action can do:

- `read`: proven not to mutate the target or grant capability;
- `local-mutation`: changes the Job's workspace or the permitted Notes area;
- `external-mutation`: changes a shared or external system;
- `consequential`: crosses a fixed Consequence Boundary; or
- `unknown`: cannot be classified with sufficient confidence.

### Consequence Boundary

An operation that always requires a person in Slack in `coworker` and `external-writes`
modes, even when the initial request appears to authorize its outcome. V1 boundaries are:

- merging or closing a pull request;
- deploying, promoting, rolling back, restarting, or changing live production;
- mutating a production database or production customer data;
- deleting shared or external resources, destructive local cleanup, broad reset, or
  irreversible/bulk mutation;
- force-pushing or deleting a shared, protected, or default branch;
- changing authentication, authorization, credentials, permissions, secrets, security
  controls, retention controls, audit controls, or organization/repository administration;
- purchases, billing changes, paid activation, or material spend;
- sending sensitive data to a new destination or expanding the audience for private data;
- sending, publishing, or posting externally when that audience and communication were not
  clearly part of the delegated task;
- bypassing a hook, branch rule, approval, sandbox, monitoring control, or other trusted
  safety boundary; and
- any action whose target, blast radius, environment, or effect remains unknown.

An operator policy may add Consequence Boundaries. It may not remove the fixed list above.
The existing exact disabled-tool floor remains in force; this feature does not re-enable
currently disabled MCP tools. If an equivalent reachable shell action is proposed, it is
still evaluated and normally lands at the appropriate Consequence Boundary.

### Thread Grant

A persisted, wrapper-owned permission created only by the **Allow similar in this Thread**
button. It has a normalized matching key, the approving Slack user, creation time, source
request, and Thread identity. It applies only within that Thread's Session and survives an
application restart for as long as the Thread mapping survives.

A Thread Grant is not fuzzy. It matches a structured key made from the action source,
operation, environment, target service, and narrow resource scope. Examples include one
GitHub operation in one repository, one Linear operation in one team, or one database
operation against one named non-production database and table. Arguments that materially
change target, audience, environment, destructive effect, or data scope produce a different
key.

Every matching action is still intercepted and answered individually. A grant must never be
implemented as general network access, blanket MCP-server approval, or an App Server
`acceptForSession` response whose effective scope is broader than the normalized key.

## User Stories

1. As a delegator, I want to assign a complete task and walk away, so that the coworker
   finishes ordinary work without requiring supervision.
2. As a delegator, I want the coworker to infer ordinary necessary implementation steps
   from my request, so that I do not approve edits, tests, commits, and other details.
3. As a delegator, I want proven reads to happen silently, so that investigation does not
   create approval fatigue.
4. As a delegator, I want a request to fix a bug and open a pull request to authorize the
   expected edits, tests, feature-branch push, and pull-request creation.
5. As a delegator, I want an investigation-only request not to silently become an
   implementation or publication task.
6. As a delegator, I want reversible, bounded updates clearly requested by me to proceed in
   coworker mode, so that normal operational work remains delegatable.
7. As a delegator, I want the coworker to pause before merging a pull request, even when a
   merge appears to be the next step.
8. As a delegator, I want the coworker to pause before changing production data or
   production services, so that live impact remains visible.
9. As a delegator, I want the coworker to pause before deleting or broadly rewriting shared
   state, so that an accidental interpretation cannot cause difficult recovery.
10. As a delegator, I want the coworker to pause when an action is materially broader than
    my request, so that a reasonable goal does not become blanket authority.
11. As a delegator, I want unknown actions to require approval, so that a new tool or
    unclear command fails conservatively.
12. As a delegator, I want the approval message in the same Thread as the Job, so that its
    context and audience are obvious.
13. As a delegator, I want an approval prompt to name the exact action, target, environment,
    consequence, and reason, so that I can decide without interpreting raw JSON.
14. As a delegator, I want to approve only the current action, so that later actions are not
    silently authorized.
15. As a delegator, I want to allow a narrowly similar class of action in this Thread, so
    that repetitive safe work does not ask the same question repeatedly.
16. As a delegator, I want to deny an action without necessarily stopping the entire Job, so
    that the coworker can find a safer path.
17. As a delegator, I want an approval decision to be visibly recorded with who decided and
    when, so that the Thread remains understandable later.
18. As a delegator, I want expired or already-resolved buttons to say so without changing
    the action, so that duplicate clicks cannot race execution.
19. As a delegator, I want only the current Job's delegator to approve its action, so that a
    channel observer cannot grant authority on my behalf.
20. As a Schedule creator, I want approvals for an Occurrence to be addressed to me in that
    Occurrence's Thread, so that scheduled work has the same safety model as manual work.
21. As a Thread observer, I want routine auto-approval decisions to remain out of Slack, so
    that the Thread is not flooded with internal policy narration.
22. As a Thread observer, I want existing Write receipts to remain after an approved action
    executes, so that approval intent does not replace evidence of the outcome.
23. As an operator, I want `coworker` to be the default mode, so that the product remains
    useful without configuration.
24. As an operator, I want an `external-writes` mode, so that a more sensitive installation
    can confirm every external mutation without prompting for reads or local work.
25. As an operator, I want an `off` mode, so that I can intentionally retain current
    behavior or compare behavior during rollout.
26. As an operator, I want to express trusted policy in natural language, so that local
    workflows can be tuned without writing a general-purpose policy program.
27. As an operator, I want policy to auto-allow named ordinary workflows, so that expected
    ticket, pull-request, staging, or internal-system operations stay frictionless.
28. As an operator, I want policy to make a normally automatic workflow require approval,
    so that local sensitivities can be stricter than the built-in default.
29. As an operator, I want fixed safety boundaries and explicit deny rules to outrank prose,
    so that a vague policy cannot disable the safety floor.
30. As an operator, I want policy parse failures, reviewer failures, and timeouts to ask
    rather than allow, so that availability problems do not become permission grants.
31. As an operator, I want read-only database credentials and declared read-only tools to
    proceed without prompting, so that analysis remains useful.
32. As an operator, I want database access using a write-capable credential to be treated
    conservatively unless its operation is confidently classified, so that a textual
    `SELECT` assumption is not the safety boundary.
33. As an operator, I want all MCP calls intercepted even when server annotations are
    incomplete, so that a connector cannot bypass policy by omitting a destructive hint.
34. As an operator, I want shell network access intercepted, so that `gh`, `curl`, a
    database client, or another executable cannot bypass an MCP decision.
35. As an operator, I want credentials and server-side protections to remain independently
    scoped, so that approval policy is not the only defense.
36. As an operator, I want startup to report the active approval mode and enforcement
    posture, so that I know what the instance is actually running.
37. As an operator, I want configuration typos to stop startup, so that a misspelled safety
    setting cannot silently fall back.
38. As an operator, I want pending approvals invalidated when their Turn is stopped,
    expires, or crashes, so that an old button cannot execute abandoned work.
39. As an operator, I want Thread Grants stored outside agent-writable workspaces, so that a
    Job cannot grant itself future authority.
40. As an operator, I want policy decisions logged without secrets or full sensitive
    payloads, so that behavior is auditable without creating a new data leak.
41. As an operator, I want an App Server contract test against the installed Codex version,
    so that upstream protocol drift is detected before deployment.
42. As an operator, I want the existing Session-per-Thread behavior preserved, so that this
    feature does not change conversational memory or audience isolation.
43. As an operator, I want approval waits to obey existing Job and Turn bounds, so that
    abandoned approvals cannot consume resources forever.
44. As an operator, I want stopping a Job to cancel its pending approval and engine action,
    so that Stop remains a real hard stop.
45. As a developer, I want approval policy expressed in wrapper vocabulary rather than
    Codex protocol types, so that engine replacement remains bounded to the adapter.
46. As a developer, I want deterministic rules and Thread Grants tested separately from the
    contextual reviewer, so that failures can be localized.
47. As a developer, I want the exact action and trusted context clearly separated from
    untrusted evidence in the reviewer prompt, so that retrieved prompt injection cannot
    authorize itself.
48. As a developer, I want repeated or concurrent Slack action deliveries to be idempotent,
    so that Slack retries cannot execute an action twice.

## Implementation Decisions

### 1. Supersede the no-approval engine decision

Add a new ADR that supersedes the engine choice only where necessary: Codex remains the
agent engine, but ordinary Jobs move from `codex exec` through the TypeScript SDK to Codex
App Server over stdio JSON-RPC. The existing `exec` adapter is replaced, not wrapped with a
command shim. WebSocket transport is unnecessary.

The ADR must also amend the unattended-action boundary: the token, deny-list, repository
protection, and local hook remain defense in depth, while the Approval Gate becomes the
intent-aware pre-execution boundary. Existing documentation that says the wrapper is not in
the tool path or cannot ask permission must be updated.

### 2. Preserve the engine port

Codex protocol types remain confined to the engine adapter. Extend the wrapper's engine port
with a normalized Planned Action and a response capability. The Job runner supplies an
approval handler when it starts a Turn. Existing progress events, Session identity,
resumption behavior, cancellation signal, image inputs, and usage reporting remain in the
wrapper vocabulary.

The response capability is single-use and supports `allow` and `deny`; the wrapper does not
expose App Server's broad session-accept option to policy code. The adapter correlates every
server request with its JSON-RPC response, resolves it exactly once, and translates server
notifications into the existing progress stream.

### 3. Run one supervised App Server process

The engine owns one long-lived App Server child process for the application instance. It
initializes capabilities once, multiplexes concurrent Sessions, and maps the existing
Session ID store to App Server thread IDs. A process exit fails all active Turns and pending
approval requests through the existing engine-error path. A new process may resume only
completed Turns using the existing Session mapping; an interrupted Turn is not silently
replayed.

Use the installed or configured Codex binary exactly as today. Authentication and MCP
credentials continue to come from the operator's environment and Codex configuration.
Startup reports the installed version and validates that the required App Server methods and
request variants are present. Protocol drift is fatal during preflight rather than deferred
to the first Slack Job.

### 4. Make approval interception complete

In `coworker` and `external-writes` modes, ordinary Job Sessions start with interactive App
Server approvals routed to the wrapper, not Codex's built-in automatic reviewer.

The technical sandbox for guarded ordinary Job Sessions starts read-only with outbound shell
network disabled. File mutation or a command that needs mutation/network capability must
therefore cross an App Server approval request before execution. All configured MCP servers
use a mode that requests approval before every tool invocation. The wrapper then silently
allows proven reads and other policy-approved actions. This internal interception may happen
frequently; Slack prompts must not. Any narrowly expanded filesystem or network capability
is granted for the exact request, not installed as a broad Session capability.

Do not enable unrestricted outbound shell network access in these modes. Otherwise a model
could replace an MCP write with `gh`, `curl`, a language SDK, or a database CLI and bypass
the gate. Do not answer a network request with a destination-wide or Session-wide grant.
Approve the exact triggering command once.

In `off` mode, configure App Server to reproduce today's workspace-write, network-enabled,
approval-never behavior. The engine migration must not secretly make `off` stricter.

### 5. Keep local work autonomous

The Job workspace is the coworker's own desk. In `coworker` and `external-writes`, local
workspace edits, generated files, dependency operations, tests, commits, and other bounded
local mechanics are auto-allowed when they are ordinary consequences of a change/build/fix
Job. For answer, explain, review, diagnose, or plan Jobs, local mutation is not presumed to
be authorized merely because it is technically reversible.

Authorized Notes changes and the Librarian's ordinary filing pass remain automatic. The
Librarian runs without external tools or outbound network capability. If it unexpectedly
requests an external effect, deny it; never create a Slack approval after the Job's answer
for bookkeeping work.

### 6. Policy evaluation order

Evaluate every Planned Action in this exact order. An earlier `ask` or `deny` cannot be
weakened by a later `allow`:

1. Validate and normalize the action. An invalid or incomplete action becomes `unknown`.
2. Apply the hard forbidden floor. A match returns `deny` and cannot be overridden.
3. Apply matching explicit deterministic `deny` rules.
4. Apply fixed Consequence Boundaries. A match returns `ask` in `coworker` and
   `external-writes`.
5. Apply matching explicit deterministic `ask` rules.
6. Apply a matching Thread Grant or explicit deterministic `allow`, but only if the current
   normalized action remains outside
   the forbidden floor and fixed Consequence Boundaries.
7. Prove and auto-allow reads.
8. Evaluate the trusted natural-language policy and goal alignment for remaining actions.
9. Apply the active mode's fallback.
10. Any parse error, missing fact, reviewer error, timeout, unsupported action type, or low
   confidence returns `ask`.

`off` bypasses steps that would ask, but it does not re-enable tools or credentials already
forbidden by other configuration.

### 7. Decision behavior by mode

`coworker` is the default:

- proven reads are allowed;
- authorized local mutations are allowed;
- bounded, reversible external mutations are allowed when their target, audience,
  environment, and effect clearly match the Job's Goal Context;
- fixed Consequence Boundaries ask;
- materially out-of-goal actions ask; and
- unknown actions ask.

`external-writes` is the optional strict baseline:

- proven reads are allowed;
- authorized local workspace and Notes mutations are allowed;
- every external mutation asks, even when clearly goal-aligned, unless an explicit operator
  allow or matching Thread Grant already authorizes that narrow class;
- fixed Consequence Boundaries ask; and
- unknown actions ask.

`off` preserves current behavior and creates no Slack approval UI.

Representative `coworker` decisions are normative:

- “Fix this bug and open a PR” permits edits, tests, a feature-branch push, and PR creation.
- “Investigate why CI fails” permits inspection but asks before implementing or publishing
  a change.
- “Update these five staging test records” permits that bounded staging mutation when the
  target and credential scope are established.
- “Correct customer balances in production” asks before the production mutation.
- “Prepare the release” permits preparation and asks before deployment or merge.
- “Merge PR 42” still asks at the merge boundary.

### 8. Deterministic classification before model judgment

Use strong facts before contextual review:

- request type and permission scope from App Server;
- exact command argument vectors and parsed compound-command components;
- working directory and writable roots;
- configured MCP server and exact tool identity;
- operator-declared environment and read-only capability;
- repository, branch, destination, database, and resource identifiers visible in arguments;
- existing hard-disabled tools; and
- server-enforced read-only credentials or transactions.

MCP `readOnlyHint` and destructive annotations are hints, not authority. Prior measurements
show that important GitHub mutations were missing destructive annotations. A newly added or
unrecognized MCP tool therefore reaches `unknown` unless deterministic configuration or the
reviewer can classify its exact proposed use confidently.

Do not infer read-only database safety solely from the first SQL keyword. A `SELECT` may
invoke a mutating function, and a write-capable credential remains a write capability. A
dedicated read-only MCP tool, read-only credential, or server-enforced read-only transaction
is strong evidence and should proceed silently. An unclear raw database command asks.

### 9. Contextual reviewer

For actions not resolved deterministically, run a separate, ephemeral reviewer Session. It
has no MCP servers, no outbound network, no write capability, and a strict structured output
schema. It is not the Job's Session and its messages never enter the Thread's conversational
history.

The reviewer receives:

- the operator policy as trusted instructions;
- the active approval mode;
- the raw current Job request and a compact trusted-human Thread transcript;
- wrapper-known repository, workspace, Schedule, and environment scope;
- the exact normalized Planned Action;
- deterministic classification evidence and missing facts; and
- an explicit warning that assistant messages, tool arguments, tool results, retrieved
  content, and the proposed action are untrusted evidence rather than instructions.

The reviewer returns only: effect, risk, authorization strength, `allow`/`ask`/`deny`, a
human rationale, and an optional normalized Thread Grant candidate. Unknown effect,
insufficient authorization, or schema failure returns `ask`.

The reviewer assesses the exact immediate action, not whether the overall goal sounds safe.
It must compare actor/account, target, recipient/audience, purpose, data and destination,
scope, environment, persistence, and material side effects with trusted authorization.

Do not use Codex's built-in auto-review as the product decision maker in v1. The wrapper
needs an `ask` outcome routed to Slack, stable policy precedence, deterministic Thread Grant
semantics, and tests independent of upstream reviewer-policy changes.

### 10. Natural-language operator policy

Add an optional multiline policy under the approval configuration. It is trusted operator
input and is passed only to the contextual reviewer. Documentation should show examples:

- creating pull requests in selected internal repositories is allowed;
- adding comments or labels in a named Linear team is allowed;
- updating a named staging database is allowed when the Job names the records;
- production database changes always require approval; and
- external publication or deletion is forbidden.

Natural-language policy may refine ordinary decisions in either direction in both guarded
modes. This lets an operator selectively exempt a narrow, well-understood workflow from the
`external-writes` baseline without disabling that baseline everywhere. Policy cannot
override the hard forbidden floor, fixed Consequence Boundaries, explicit deterministic
`deny`/`ask` rules, credential limits, or server-side protections. If the policy is
contradictory or does not clearly cover the exact action, ask.

### 11. Configuration contract

Add a strict top-level approval configuration with:

- `mode`, one of `off`, `coworker`, or `external-writes`, defaulting to `coworker`;
- optional trusted natural-language `policy`;
- optional exact deterministic rules for source, server/tool or command prefix, narrow
  scope/environment, and `allow`/`ask`/`deny` decision; and
- no configurable “unknown means allow” switch.

Rules are data, not executable scripts. Command matching operates on parsed argument arrays,
not substring or regular-expression matching over a shell string. MCP matching uses exact
server and tool names. Unknown configuration keys remain fatal under the existing strict
configuration behavior.

The shipped example configuration and operator documentation must explain all modes,
precedence, natural-language limits, read-only database proof, Thread Grants, and the
difference between approval policy and credential/server protections.

Preflight logs the active mode, whether natural-language policy and deterministic rules are
present, the sandbox/network interception posture, and that all enabled MCP servers are
approval-intercepted. It never logs policy contents, tool arguments, credentials, or
sensitive payloads.

### 12. Slack approval presentation

The approval message is posted in the Job's Thread and contains:

- a clear “Approval required” heading;
- the action category in human language;
- the target service/resource and environment;
- a redacted, bounded preview of the command or tool operation;
- the expected effect and risk;
- why the action was not automatically authorized;
- the scope that **Allow similar in this Thread** would grant; and
- a note that the Job is paused on this action.

Secrets, bearer tokens, authorization headers, full sensitive SQL values, and oversized
payloads are redacted before rendering or logging. The message includes accessible fallback
text in addition to Block Kit blocks.

Button action identifiers are stable constants. Button values contain only an opaque,
unguessable approval request ID, never a serialized command, policy, or credential. Use
Socket Mode and acknowledge each `block_actions` payload immediately, before policy state or
engine work.

Button order and labels are fixed:

1. **Approve once** — primary action;
2. **Allow similar in this Thread**; and
3. **Deny** — danger-styled action.

### 13. Slack authorization and races

Only the Slack user who created the current Job may approve or deny it. For a Scheduled Job,
only the Schedule creator may decide. Other users receive an ephemeral explanation and do
not affect the request. Supporting configured backup approvers or channel-wide approval is
out of scope for v1.

The first authorized decision wins atomically. Slack retries and repeated clicks are
idempotent. Later clicks receive “already decided” or “no longer active” and never send a
second engine response. A click is accepted only when its opaque ID maps to a pending request
for the same Thread and active Turn.

On resolution, remove the buttons and update the original approval message with the final
decision, deciding user, timestamp, and whether a Thread Grant was created. Keep a structured
server audit event with redacted action identity, decision source, rule/grant ID, and
rationale. Routine automatic allows are server audit events only and do not post to Slack.

### 14. Approval lifecycle

While waiting, Progress changes to a stable “Waiting for approval” state without pretending
that execution continues. The App Server action has not run.

- **Approve once:** respond `accept` for the exact request and resume the Turn.
- **Allow similar:** validate and persist the normalized Thread Grant, then respond `accept`
  for the exact request.
- **Deny:** respond `decline` with a concise reason. The Turn may continue and find a safer
  route; denial does not automatically stop the Job.
- **Stop, bound expiry, engine exit, or process shutdown:** cancel/decline every pending
  request, mark its Slack message inactive when possible, and ensure later button clicks do
  nothing.

Approval waiting counts toward the existing Turn wall-clock bound and holds the Job's normal
queue/concurrency slot. This avoids introducing a second suspended-Job scheduler. Operators
who want longer human response time configure the existing Turn bound. No independent
approval timeout is added in v1.

Pending approvals are not resumable after a process crash because the interrupted Turn is
not resumable. Persist enough non-sensitive metadata to recognize old button IDs after
restart and report them as inactive, but never attempt to replay the planned action.

### 15. Thread Grant storage and matching

Store Thread Grants with the wrapper's durable operational state, outside the Vault and all
agent-writable workspaces. Persist them atomically. They are keyed by Thread plus normalized
scope and include provenance.

Before using a grant, re-run forbidden-floor, fixed-boundary, deterministic-rule, and action
normalization checks. A later operator-policy or rule change takes precedence over an older
grant. A grant never crosses Threads, even when two Threads concern the same repository.

The normalized key is deterministic and reviewable. V1 does not use embeddings, semantic
similarity, or a model to decide whether a later action matches. If a useful semantic key
cannot be constructed, use the exact canonical action fingerprint as the key. This keeps all
three buttons present while ensuring the fallback grant is no broader than the action being
approved. Never create a server-wide, host-wide, environment-wide, or otherwise broad
fallback key.

### 16. MCP behavior

The project-owned MCP registry remains the only connector registry and Codex Apps remain
disabled. Every enabled MCP server is configured to request approval for every tool call in
guarded modes. The Approval Gate resolves reads and goal-aligned ordinary writes without
Slack when policy permits.

Keep current exact disabled tools and per-server disabled tools. This PRD does not re-enable
them. Inventory evolution remains allowed, but every new tool is intercepted and initially
conservative rather than silently available for mutation.

The wrapper still does not proxy or normalize connector business APIs. It normalizes only
the pre-execution approval envelope. Tool execution and result handling remain between Codex
and the configured MCP server after approval.

### 17. Shell, git, GitHub, and network behavior

No command-name shim is part of the design. `git`, `gh`, `curl`, language SDKs, database
clients, and future executables are treated uniformly through command and network approval
requests.

A feature-branch push clearly required by a change Job may be auto-allowed in `coworker`.
Pushing to a default/protected/shared branch, deleting a branch, broad refspecs, force push
outside a verified agent-owned feature branch, `--no-verify`, or hooks-path overrides reach a
Consequence Boundary.

Creating a pull request is an ordinary reversible external mutation when the Job requested
implementation/publication or clearly asked for a PR. It is out of goal for a review or
investigation-only Job. Merging or closing a pull request always asks.

Repository protection verification, token scoping, disabled tools, and local hooks remain in
place. Approval does not claim to replace server-side enforcement.

### 18. Database behavior

The gate is generic; no PostgreSQL-specific approval subsystem is built. Database operations
arrive as MCP calls or shell commands and use the same Planned Action flow.

- A server-enforced read-only connector, credential, or transaction is classified as read.
- A clearly bounded non-production mutation matching the Job may be allowed in `coworker`.
- Every external mutation asks by default in `external-writes`; only an explicit narrow
  operator allow or matching Thread Grant may exempt it.
- Every production mutation asks in guarded modes.
- Unknown SQL, dynamic SQL, stored-procedure effects, broad predicates, unclear environment,
  or unclear credential capability asks.
- Destructive or bulk data changes reach the fixed Consequence Boundary.

The approval preview names database/environment, operation type, affected resource, and
bounded predicate/record count when known, while redacting values likely to contain customer
or secret data.

### 19. Existing reporting behavior

Approval is permission, not proof that a Write succeeded. After an approved action executes,
the existing result and Write-reporting paths remain responsible for reporting its actual
outcome. Denied or cancelled actions do not create Write receipts.

The approval message is separate from the Job's one revised Progress message and from
permanent Write receipts. It may be updated only to settle its own pending state. Automatic
policy decisions do not become Thread messages.

### 20. Rollout and compatibility

Ship the App Server adapter and Approval Gate together behind the configured mode. The
default changes to `coworker` only when the preflight contract test and guarded-mode
end-to-end tests pass. `off` provides an operational escape hatch but is never selected
automatically after a guarded-mode failure.

A reviewer failure asks; an App Server protocol incompatibility fails startup; neither may
silently fall back to `off`.

Update the Slack app manifest/setup documentation to enable interactive components over
Socket Mode. Buttons do not require a public HTTP endpoint. Preserve immediate action
acknowledgement within Slack's three-second requirement.

## Testing Decisions

### Testing philosophy

Tests assert observable permission and Job behavior, not private classifier implementation
or JSON-RPC message ordering beyond the adapter contract. The primary question is always:
did the exact action execute before authorization, did Slack receive the correct prompt, and
what happened after a decision?

Use the highest existing seam wherever possible. The repository already has a synthetic
Slack mention harness, fake Engine and Slack ports, Session/Job orchestration tests, strict
configuration tests, and a real-engine adapter boundary. Extend those rather than creating a
parallel test application.

### Primary Job-level tests

Drive synthetic mentions through the real coworker orchestration with a fake Engine that can
emit a pending Planned Action and wait for its response, plus a fake Slack port that records
Block Kit approval messages and simulates button actions.

Cover at least:

1. proven reads complete with no approval message;
2. authorized local edits complete with no approval message;
3. a goal-aligned PR creation is automatic in `coworker`;
4. the same PR creation asks in `external-writes`;
5. PR creation asks for an investigation-only Job;
6. merge always asks;
7. production database mutation always asks;
8. bounded staging mutation is automatic in `coworker` when authorized;
9. unknown action asks;
10. natural-language policy may allow an ordinary default prompt;
11. natural-language policy may require approval for an ordinary default allow;
12. hard deny and explicit ask/deny outrank natural-language policy;
13. Approve once resumes only the pending action;
14. Allow similar persists a narrow Thread Grant and suppresses the next matching prompt;
15. a changed target, environment, audience, or operation does not match the grant;
16. a grant in one Thread never applies in another;
17. Deny returns control to the engine without executing the action;
18. a denied Job may continue with a safer action and finish;
19. only the delegator or Schedule creator may decide;
20. duplicate and concurrent clicks resolve exactly once;
21. stopping or timing out a Job invalidates the button and prevents execution;
22. engine failure invalidates all pending requests;
23. approval waiting uses the existing Turn bound and concurrency slot;
24. Progress shows waiting and resumes after approval;
25. an approved successful Write still produces its normal result/audit behavior;
26. a denied action produces no Write receipt; and
27. scheduled and manually invoked Jobs use the same Approval Gate.

### Policy tests

Use table-driven tests at the pure policy seam for all three modes, effect classes,
authorization strengths, environments, fixed boundaries, deterministic precedence, reviewer
failure, redaction, and unknown fallback.

Test command normalization with argument vectors and compound shell commands. Include
alternate paths to the same outcome: MCP GitHub tool, `gh`, `curl`, a script, and an unknown
binary. The expected safety decision follows effect and Goal Context, not executable name.

Test MCP annotations as non-authoritative hints: missing destructive metadata cannot turn a
mutation into a read, and a new tool without enough evidence becomes unknown.

Test database classification using a proven read-only connector, write-capable raw SQL,
stored procedures, staging mutation, production mutation, broad update/delete, and redacted
approval previews.

### Slack tests

At the Slack port/gateway seam, assert:

- correct Block Kit structure and accessible fallback text;
- stable action IDs and opaque request values;
- immediate acknowledgement before asynchronous decision handling;
- requester authorization;
- ephemeral rejection for unauthorized users;
- atomic first-decision-wins behavior;
- update/removal of buttons after resolution;
- inactive behavior after stop, timeout, restart, or duplicate delivery; and
- redaction and bounded preview size.

Perform one manual live-channel Socket Mode smoke test in a test workspace: post a real
approval message in a channel Thread, click each button path, and verify the pending action
does not execute before the click. DM-only behavior is not sufficient evidence.

### Real App Server contract test

Start the actual configured Codex App Server over stdio in an isolated temporary workspace
with no production credentials. Ask it to perform a harmless marker mutation that requires
approval. Assert that:

1. the adapter receives a normalized Planned Action;
2. the marker does not exist before a decision;
3. `allow` creates the marker and completes the Turn;
4. `deny` leaves the marker absent and returns a declined result;
5. cancellation kills or clears the pending action;
6. Session identity can be resumed after a completed Turn; and
7. required request variants and event translations match the installed Codex version.

Add a second harmless contract case for a local test MCP server configured to prompt on all
tools: a read call is auto-resolved by policy, while a mutation is held until a decision.
No real GitHub, database, or Slack mutation belongs in automated tests.

### Configuration and persistence tests

Test default `coworker`, explicit modes, multiline policy, deterministic rules, unknown-key
rejection, invalid decision/scope rejection, startup reporting, atomic Thread Grant storage,
restart loading, policy-change precedence over old grants, and inactive pending-button
recognition after restart.

### Regression expectations

All existing Session-per-Thread, Job queue, Turn bounds, Stop, Progress, Write reporting,
Vault, Librarian, Schedule, connector preflight, and configuration tests must continue to
pass. Update tests that intentionally assert approvals are disabled; do not weaken unrelated
behavior to accommodate the new adapter.

## Acceptance Criteria

1. The shipped default is `coworker` and a normal fix/build Job completes ordinary local and
   reversible goal-aligned work without Slack approval prompts.
2. Proven reads through shell or MCP do not prompt in guarded modes.
3. All enabled MCP tool calls are intercepted before execution in guarded modes.
4. Shell network operations cannot bypass the gate through `gh`, `curl`, scripts, SDKs, or
   database clients.
5. Fixed Consequence Boundaries and unknown actions produce a Slack approval request before
   execution.
6. The action cannot execute before the corresponding App Server request is resolved.
7. Slack offers exactly Approve once, Allow similar in this Thread, and Deny.
8. Only the current delegator or Schedule creator can decide; the first valid decision wins.
9. Approve once grants no future permission.
10. Allow similar creates a deterministic narrow Thread Grant and never a broad network or
    Session grant.
11. Deny prevents that action and gives the agent a chance to continue safely.
12. Stop, timeout, engine exit, and restart invalidate pending approvals.
13. Natural-language policy tunes ordinary decisions but cannot weaken fixed boundaries,
    explicit ask/deny rules, hard denies, credentials, or server protections.
14. Reviewer and classification failures ask rather than allow.
15. `external-writes` asks before every external mutation not covered by an explicit narrow
    operator allow or matching Thread Grant, and not before proven reads or authorized local
    work.
16. `off` reproduces current no-approval behavior without becoming an automatic fallback.
17. Existing Write receipts report outcomes independently from approval messages.
18. The real App Server and MCP contract tests prove pre-execution blocking.
19. Preflight refuses an incompatible App Server protocol instead of accepting Jobs.
20. Documentation and ADRs accurately describe the new action boundary and residual risk.

## Out of Scope

- A command shim for `git`, `gh`, `curl`, database clients, or any individual executable.
- A service-specific GitHub, Linear, Slack, or database approval subsystem.
- A proxy that normalizes connector business APIs.
- Replacing Codex as the agent engine.
- Re-enabling MCP tools currently disabled by the irreversible-action floor.
- Channel-wide approval, approval delegation, backup approvers, or organization role lookup.
- Approval by typing magic words into Slack; v1 decisions use buttons only.
- Approval links outside Slack, email approval, mobile push approval, or a web dashboard.
- Fuzzy or embedding-based “similar action” matching.
- Cross-Thread, global, time-window, or permanent approval grants.
- Letting natural-language policy remove fixed Consequence Boundaries or hard denies.
- A complete SQL parser or proof of stored-procedure purity.
- Automatic recovery or replay of an action pending when the process crashed.
- Suspending pending Jobs without consuming the existing queue slot.
- Replacing credential scoping, repository protection, network controls, or service-side
  authorization with model judgment.
- Persisting or displaying hidden model reasoning.

## Further Notes

### Why App Server

Codex App Server is the supported rich-client integration surface for approvals and streamed
agent events. It sends server-initiated requests for command execution, file changes,
permissions, and MCP elicitation, and accepts one-time decisions. This is the capability the
current non-interactive SDK path deliberately lacks.

OpenAI's documented safety architecture separates the technical sandbox boundary from the
approval policy and describes automatic review as a reviewer swap, not a permission grant.
Its reviewer evaluates the exact planned action against recent conversation context and user
authorization. This PRD adopts that separation while keeping the final `ask` decision in the
product's own Slack workflow.

Claude Code independently uses the same useful shape: permission modes establish a baseline,
deny/ask/allow rules refine it, and its automatic mode checks whether an action aligns with
the user's request. This PRD intentionally implements only the subset needed by open-agent.

Primary references:

- OpenAI Codex App Server: https://learn.chatgpt.com/docs/app-server
- OpenAI agent approvals and security: https://learn.chatgpt.com/docs/agent-approvals-security
- OpenAI auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- OpenAI default reviewer policy: https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/policy.md
- OpenAI deployment description: https://openai.com/index/running-codex-safely/
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code hooks and permission requests: https://code.claude.com/docs/en/hooks
- Slack Bolt actions: https://docs.slack.dev/tools/bolt-js/concepts/actions
- Slack acknowledgement requirement: https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/

### Security claim

The Approval Gate substantially improves intent-aware safety, but it is not a mathematical
proof that no mutation can occur. The enforceable claim is narrower:

- in guarded modes, configured action paths are placed behind App Server interception;
- unknown and consequential actions wait for a trusted Slack decision;
- exact grants do not broaden future technical capability;
- shell network and MCP paths are both covered; and
- credentials and server-side controls remain the final limit on what can succeed.

If unrestricted network or credentials are exposed outside the intercepted engine process,
or a future App Server action type is ignored, the claim is broken. Preflight and exhaustive
request handling are therefore part of the feature, not optional hardening.

### Previously completed proof

A live Socket Mode smoke test has already demonstrated the essential round trip in a channel
Thread: Codex App Server emitted a command-execution approval request, Slack displayed
Approve/Deny Block Kit controls, Slack acknowledged the `block_actions` event, the wrapper
returned `accept`, and the harmless marker command executed only after approval. That proof
establishes feasibility; it is not the production implementation or the full policy test.
