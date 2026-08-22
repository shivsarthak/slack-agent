# Configuration

One instance file, one MCP registry, and secrets in the environment.

`open-agent.config.json` describes the instance: where the Vault is, what stops a runaway
Job, which model, which repositories it works in, and where its MCP registry lives.
`mcp.json` is the
single extensible registry for every MCP server. Both files **name** credentials by
environment variable and never contain their values, exactly as a
[Skill](../CONTEXT.md#skill) does. `.env` is the keyring.

The environment configures nothing else. Two sources for one setting is how an instance ends
up running with bounds nobody wrote down. The single exception is `CONFIG_PATH`, which says
where the file is and cannot live inside it.

Start from [`open-agent.config.example.json`](../open-agent.config.example.json) and
[`mcp.example.json`](../mcp.example.json). Every instance section is optional. `mcpConfig`
defaults to `mcp.json` beside the instance file; when that default file is absent, the
instance runs without MCP servers. An explicitly named missing MCP file is an error.

**Relative paths resolve against the file's own directory**, not the working directory, so a
checkout that moves stays configured.

## What startup does with it

`src/preflight/` reads this file and then goes and checks it, before the first mention is
accepted. Two severities, and the difference is deliberate:

- **A report** describes an instance that will work. Version drift, the repository list, the
  bounds, the sandbox posture. Some are warnings — "this will behave in a way you may not
  have intended".
- **A refusal** describes an instance that cannot satisfy its configuration: a missing
  named credential, an unreachable connector, or a Skills directory the agent could
  rewrite.

## The sections

### `slack`

```json
"slack": { "botTokenEnvVar": "SLACK_BOT_TOKEN", "appTokenEnvVar": "SLACK_APP_TOKEN" }
```

Which variables hold the two tokens. Naming them is what lets one machine run two instances
against two workspaces. The bot token is checked with `auth.test` at startup and the
workspace it belongs to is printed — which is when you find out you started the instance
against the wrong one.

### `vault`

```json
"vault": { "notes": "./vault/Notes", "skills": "./vault/Skills" }
```

The two halves of the Vault, **divided by who may write them**. `notes` is passed to the
engine as writable; `skills` is passed to nothing, and that omission is the entire
enforcement of the rule that Skills are human-authored.

They must be siblings, under the directory you open in Obsidian, and not in a temporary
directory (`workspace-write` grants those unconditionally, so Skills there would be
writable). Startup refuses to run otherwise — see [docs/skills.md](skills.md). Set `notes`
alone and `skills` follows it.

### `stateDir`

```json
"stateDir": "./.state"
```

Durable wrapper state. Session mappings, the atomically replaced `schedules.json`, and
Thread grants/inactive approval IDs in `approvals.json` live here, along with the append-only
`vault-changes.jsonl` server log. Each Vault record is one
JSON object containing the
timestamp, action, Note path, originating Thread and Job, optional attribution detail, and
the full available diff. Vault bookkeeping is not posted into Slack; external Write
receipts are unchanged. Relative paths resolve against the instance file as usual.

### `bounds`

What stops a Job that does not stop by itself. Codex supplies none of this — no timeout, no
cap on turns, no budget, no kill switch — so these are the only ones there are.
`turnTimeoutMs` defaults to six hours and must remain below 24 hours. It applies equally to
manual and Scheduled Jobs. `maxTurnsPerJob` and `tokenBudgetPerJob` remain optional.

A Job is normally one Turn, and token usage arrives only at Turn completion. A configured
token budget can therefore refuse the *next* Turn but cannot interrupt the one already
spending; configure `turnTimeoutMs` when a hard wall-clock ceiling is required.

`maxConcurrentJobs` still defaults to four to protect shared Slack rate limits, and
`librarianTimeoutMs` defaults to five minutes because curation is best-effort work that
should not hold the next Job indefinitely.

### `workspaceRetention`

```json
"workspaceRetention": {
  "inactivityMs": 3600000
}
```

After one hour without a Job, reproducible dependency and build caches are removed. A
complete Thread workspace is reclaimed only when every checkout has no local changes,
ignored local data, detached HEAD, branch without an upstream, or commits ahead of its
upstream. Before a clean workspace is removed, its exact branch and commit are recorded in
wrapper-owned state so a later Job can recreate the same checkout. Any Job in the Thread
refreshes the inactivity clock.

### `fileTransfer`

```json
"fileTransfer": {
  "maxDownloadBytes": 20971520,
  "maxUploadBytes": 20971520
}
```

The byte ceilings for Slack attachments entering a Job and result artifacts returning to
the Thread. Both default to 20 MiB. Incoming files are rejected from Slack metadata before
download when they are already too large; downloaded bytes are checked again. Output files
are checked on disk before upload.

Our Slack app needs `files:read` to download private attachment URLs, `files:write` to
share result artifacts, and `users:read` to resolve a Schedule creator's timezone. Changing
any scope requires reinstalling the app in the workspace. The existing conversation-history
scopes let the coworker retrieve supported
files from earlier replies in the same Thread through `conversations.replies`.

### `engine`

`model`, `reasoningEffort`, and optionally `codexPath`. `low` effort is the right default
across many shallow Jobs; if considered answers come back thin, this is the first dial to
turn, not the prompt.

### `approvals`

```json
"approvals": {
  "mode": "coworker",
  "policy": "Creating pull requests in acme/shop is ordinary when the Job requests one.",
  "rules": []
}
```

The default is `coworker`: proven reads and ordinary reversible work that matches the
delegated Job proceed silently; consequence boundaries, out-of-goal actions, and unknowns
pause in the same Slack Thread. `external-writes` additionally asks before every external
mutation unless a narrow explicit allow or Thread Grant matches. `off` explicitly restores
the previous unattended posture and produces no approval UI. There is no `all-writes` mode.

Optional `policy` is trusted natural-language guidance for an isolated contextual reviewer.
It may allow or tighten ordinary workflows, but cannot weaken disabled tools, fixed
consequence boundaries, or explicit `ask`/`deny` rules. Reviewer failures and ambiguity ask.

Rules are strict data. A command rule uses an argument-array `commandPrefix`; an MCP rule
uses exact `server` and `tool`; optional `scope` and `environment` narrow either. `decision`
is `allow`, `ask`, or `deny`. Deny, fixed boundaries, and ask outrank grants and allows.
Unknown keys stop startup.

An approval message offers exactly Approve once, Allow similar in this Thread, and Deny.
Only the Job's delegator or Schedule creator can decide. Similar grants are deterministic,
narrow, confined to that Thread, and stored under `stateDir` outside the Vault and Job
workspaces. They never become blanket network, MCP-server, or App Server Session access.
Approval waiting uses `bounds.turnTimeoutMs`; Stop and expiry invalidate the buttons.

Approval is not a replacement for capability boundaries. Keep credentials read-only where
possible, especially for databases: a textual `SELECT` over a write-capable credential is
not proof of read-only behavior. Disabled MCP tools, repository protection, hooks, and
service-side authorization remain independently effective.

### `mcpConfig` and `mcp.json`

`mcpConfig` points to the one MCP registry and defaults to `./mcp.json`:

```json
"mcpConfig": "./mcp.json"
```

The registry is an `mcpServers` map. MCP standardizes the protocol and transports, but
does not currently standardize this file format; this is open-agent's validated contract.
The included [`mcp.schema.json`](../mcp.schema.json) provides editor completion.

```json
{
  "$schema": "./mcp.schema.json",
  "mcpServers": {
    "linear": {
      "type": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "bearerTokenEnvVar": "LINEAR_API_KEY"
    }
  }
}
```

Adding a server is one new object. A remote server uses `type: "streamable-http"` with:

- `url`
- optional `bearerTokenEnvVar`
- optional non-secret `httpHeaders`
- optional `envHttpHeaders`, mapping header names to environment-variable names

A local server uses `type: "stdio"` with:

- `command` and optional `args`
- optional `cwd`, resolved relative to `mcp.json`
- optional non-secret `env`
- optional `envVars`, naming variables to forward without copying their values into config

Local stdio entries execute software on the host. Pin package versions in their arguments;
startup prints a warning naming every local command. Both transports are handled by the
official [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk)
v2 SDK during preflight. Codex receives the same validated entries through its own MCP
configuration, so there is no second server list to synchronize.

Codex Apps/connectors are a separate tool source and are enabled by Codex by default. The
engine disables that source for Jobs, so separately authorized apps cannot add tools outside
this registry; only the MCP servers validated from `mcp.json` are exposed.

Codex resolves connector credentials for MCP calls. In guarded modes App Server intercepts
configured invocations for the Approval Gate while execution and results remain between
Codex and the server. The one exception is the read-only GitHub repository-protection check: startup
resolves the GitHub connector's bearer token to call the repository and rules endpoints
described below.

Every enabled entry may also carry open-agent's policy:

- **`disabledTools`** — optional extra tools to disable. It defaults to `[]`. The known
  irreversible ones are blocked for you (below), so this is for a judgement this project
  has not made.
- **`enabled`** — set to `false` to keep an entry without probing or exposing it.
- **`startupTimeoutSec` / `toolTimeoutSec`** — optional Codex MCP timeouts.

MCP tool calls do not create separate Slack receipt messages. Relevant connector outcomes
belong in the Job's final answer; routine reads should not add chatter to the Thread.

MCP inventories are deliberately **not pinned**. Startup verifies that each enabled server
can be reached and reports its current tool count, but tools may appear or disappear without
blocking the service. This keeps upstream server releases from turning into open-agent
outages. If a particular tool should never be available, name it in `disabledTools`.

#### What is blocked for you

Generated per server from the pin, and delivered as Codex's `disabled_tools` — so the tool
does not exist from the coworker's point of view:

| Blocked | Why |
| --- | --- |
| `merge_pull_request` | Publishes a branch into another branch. Not undoable from a Thread. |
| `merge_diff` | Puts commits in a repository. Not undoable from a Thread. |
| `submit_diff_review` | Approves someone's code in the coworker's name. |
| `delete_file` | Removes repository content. |
| Known Linear deletion tools | The deletion tools measured when the safety floor was written. |

The criterion is not "dangerous" but **"can a human undo this after noticing it in the
Thread?"** A wrong comment is embarrassing and stays available; Linear's `save_issue` is an
upsert and stays available too, because drawing that line at argument granularity is not
something the tool path can express.

The fixed floor covers tool names already reviewed by this project. Every discovered tool
is approval-intercepted in guarded modes; incomplete annotations never prove a read, and an
action that cannot be classified becomes a prompt. Operators can still add tool names to
`disabledTools` to remove them entirely.

### `repositories`

```json
"repositories": ["your-org/your-repository"]
```

Every named GitHub repository is checked at startup. Preflight reads its default branch,
then queries the effective rules for that branch and the contributing rulesets. The
required boundary is:

- changes must arrive through a pull request;
- at least one approving review is required;
- `current_user_can_bypass` is `never`, including for repository administrators.

An ordinary missing rule is reported as **unprotected (fixable)** and names each setting
to enable. GitHub's `403 Upgrade to GitHub Pro or make this repository public` is reported
as **unprotectable on this plan**. Both are warnings: the instance continues because
private-repository protection is unavailable on GitHub's free plan.

Continuing is a real reduction in safety. The exact MCP deny-list and the local `pre-push`
hook remain, but they are weaker than a server-side rule: `--no-verify`, a one-off
`core.hooksPath`, editing the hook, or calling GitHub over HTTP bypasses the hook, while a
new destructive MCP tool is available until somebody adds its exact name to the deny-list.
Linear has no repository-shaped third layer at all and always runs on policy and the MCP
deny-list alone.

The same list makes code checkouts available on demand. Before a Job starts, the wrapper
writes a small `checkout owner/repository` command into the Thread workspace and tells the
engine which repositories it may select. It performs **no Git operation at that point**.
A normal conversation therefore does not clone, fetch, or depend on GitHub repository
availability.

When a task actually needs local code search, edits, or tests, the coworker runs the command
for exactly the repository it needs. The command materializes it from the canonical
`https://github.com/owner/repository.git` URL into
`<workspace>/repositories/owner/repository`, or fetches it if that Thread already has the
checkout. Every Thread has its own working tree, so Jobs in different Threads can edit and
test concurrently without changing each other's branch; follow-ups in one Thread keep that
Thread's checkout. Fetching never resets the current branch or discards work.

Git uses the same fine-grained token named by the GitHub MCP entry. A checkout-local
credential helper reads that environment variable when Git asks for GitHub credentials; the
token is never written into the remote URL, repository configuration, or helper file. The
helper and the `pre-push` hook are re-installed every time the on-demand command prepares a
checkout because the checkout is writable and a previous Job could have changed either.

The Job prompt lists the configured repository names and the on-demand command, not paths to
working trees that may not exist. It explicitly reserves checkout for local code work;
repository metadata and ordinary conversation use no checkout. Once selected, code search,
edits, tests, commits, and branch push happen through the local checkout. Opening the pull
request remains a call to the official GitHub MCP server's `create_pull_request`, so it
carries the exact linked MCP audit record.

### GitHub through `mcp.json`

```json
"github": {
  "type": "streamable-http",
  "url": "https://api.githubcopilot.com/mcp/",
  "bearerTokenEnvVar": "GITHUB_TOKEN",
  "httpHeaders": {
    "X-MCP-Toolsets": "repos,issues,pull_requests",
    "X-MCP-Exclude-Tools": "merge_pull_request,delete_file"
  },
  "disabledTools": ["merge_pull_request", "delete_file"],
  "enabled": true
}
```

GitHub is an ordinary connector using GitHub's official MCP server
([ADR-0007](adr/0007-github-is-an-official-mcp-server.md)). Create a fine-grained personal
access token limited to the repositories and permissions this instance needs and put it in
`GITHUB_TOKEN`. The example ships disabled so copying it does not require a GitHub token;
change `enabled` to `true` when ready.

The server-side exclusion header avoids advertising merge and deletion tools. The local
`disabledTools` list and fixed safety floor repeat the restriction in Codex's generated
configuration. This duplication is intentional defence-in-depth, not a second connector
implementation. Git checkout and push remain ordinary local `git`; GitHub metadata, issues,
reviews, and pull-request creation use MCP.

The checkout hook is stdin-driven. It judges the remote destination ref and actual commit
ancestry, so `HEAD:main` and a forced `+refspec` cannot evade it. It blocks the default
branch, non-fast-forwards, and remote deletions while allowing ordinary feature-branch
pushes. This is accident protection, not the action boundary; `--no-verify` can bypass it,
and that escape means force-replacing the coworker's own feature branch remains technically
possible. That residual power is accepted because losing such a branch costs a redo. The
operating manual still tells the coworker not to bypass the hook or rewrite shared history.
Server-side branch protection is the boundary for the default branch.

## Version reporting

`RECORDED_CODEX_VERSION` in `src/config.ts` records the version this project last exercised.
It does not refuse startup: preflight reports the installed version and warns on drift.

Codex has no pin because v1 runs against whatever you installed to log in with, and it ships
multiple alphas a day — so the warning is the minimum that must survive that decision.
`pnpm test:contract` checks the engine still behaves as expected.
