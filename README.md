# open-agent

An AI coworker that lives in our Slack workspace. You @-mention it in a thread with
a real task, close your laptop, and come back to the work done.

So far it is the walking skeleton ([build/01](.scratch/slack-coworker/build/01-walking-skeleton.md)),
one Session per thread ([build/02](.scratch/slack-coworker/build/02-session-per-thread.md)),
a progress message ([build/03](.scratch/slack-coworker/build/03-progress-status-message.md)),
an audit trail ([build/04](.scratch/slack-coworker/build/04-audit-writes.md)),
bounds ([build/05](.scratch/slack-coworker/build/05-bounds-and-failure.md)),
a queue ([build/06](.scratch/slack-coworker/build/06-queue-at-turn-boundary.md)),
the Vault ([build/07](.scratch/slack-coworker/build/07-the-vault.md)),
Skills ([build/15](.scratch/slack-coworker/build/15-skills.md)),
preflight ([build/08](.scratch/slack-coworker/build/08-preflight.md)), and local repository
work ([build/12](.scratch/slack-coworker/build/12-git-checkout-and-pull-request.md)):
a mention goes in, one message keeps you posted on the plan and the step it is on, every
action it takes out in the world is appended to the thread permanently, and an answer
comes back into the same thread — where a follow-up days later resumes the same
conversation without you restating anything. Each thread gets its own session and
is never handed another thread's — though it is not yet _prevented_ from going and
reading one, which is measured and written down in
[ADR-0003](docs/adr/0003-vault-is-the-memory.md). It now remembers, in Markdown you own
(below), and follows procedures you write down for it.

Startup now checks itself: credentials, versions, and — for any MCP connector you configure
— that it can be reached, with the known irreversible tools disabled.
GitHub and Linear use that same connector path. GitHub is configured against GitHub's
official MCP server; its remaining work is live end-to-end verification
([build/09](.scratch/slack-coworker/build/09-github-connector.md)). Linear needs no
connector-specific implementation: its `mcp.json` entry uses the same generic MCP
configuration, preflight, deny-list, and audit path as every other connector.

The default `coworker` Approval Gate keeps routine reads, edits, tests, and bounded
goal-aligned work autonomous while pausing exact consequential or unknown actions in the
originating Thread. The person who delegated the Job can Approve once, Allow similar in
this Thread, or Deny. `external-writes` is the stricter option; explicit `off` preserves the
former unattended behavior. See [configuration](docs/configuration.md#approvals) and
[ADR-0008](docs/adr/0008-goal-aware-approval-gate.md).

Configured GitHub repositories are also checked for the server-side default-branch
boundary. Missing protection warns and continues, distinguishing a fixable missing rule
from protection unavailable on the current GitHub plan. A checkout-local `pre-push` hook
blocks default-branch pushes, non-fast-forwards, and deletions as defence-in-depth.
Each Job is told which repositories are available and gets an on-demand checkout command.
It runs that command only when the task needs local code search, edits, or tests, and only
for the selected repository; ordinary conversation performs no clone or fetch. The
per-Thread checkout persists for follow-ups and uses the GitHub connector's fine-grained
token through a credential helper rather than in the remote URL. Git owns local search,
tests, commits, and feature-branch push; GitHub's official MCP server owns pull-request
creation, and both actions land in the Thread's audit record.

The design lives in [`.scratch/slack-coworker/spec.md`](.scratch/slack-coworker/spec.md),
the domain language in [`CONTEXT.md`](CONTEXT.md), and the decisions in
[`docs/adr/`](docs/adr).

## Files in and out

Share a CSV, log, JSON export, document, archive, database, or image anywhere in a Slack
Thread, then mention the coworker. It retrieves supported files from the Thread up to that
mention, downloads them into the Job's workspace, checks the configured size ceiling, and
names their exact paths and declared types in the prompt. PNG, JPEG, GIF, and WebP files
are also attached to Codex as visual inputs.

When a result is better as a file, the coworker writes it into the Job-specific output
directory named in its prompt. The wrapper uploads every regular file there back into the
originating Thread before the final answer and appends a permanent audit receipt. Symlinks,
directories, and oversized outputs are not uploaded.

Our Slack app requires `files:read` for attachments, `files:write` for result uploads, and
`users:read` for Schedule timezones; changing scopes requires reinstalling the app. Both
transfer ceilings default to 20 MiB and
are configurable under `fileTransfer`.

Enable **Interactivity** for the Slack app. Approval buttons arrive through the existing
Socket Mode connection, so no public request URL is needed. The handler acknowledges the
button delivery immediately and resolves the held action asynchronously.

## Running it

You need Node 20+, [pnpm](https://pnpm.io), and a Codex login (`codex login`).

```bash
pnpm install
cp .env.example .env                                        # your Slack tokens
cp open-agent.config.example.json open-agent.config.json    # optional, see below
cp mcp.example.json mcp.json                                # optional MCP servers
pnpm start
```

For the scalable hosted topology behind local HTTPS, see
[Docker Compose deployment](docs/deployment.md).

To run under the supervisor (required for the admin dashboard's restart button):

```bash
sh scripts/run-agent.sh
```

## Admin dashboard

A Next.js admin UI lives in [`dashboard/`](dashboard/). It reads and writes the same
files the agent uses — config, MCP registry, operating manual, Skills — and shows
status, vault Notes, the change log, schedules, and approval grants.

```bash
cd dashboard && pnpm install && pnpm dev     # http://localhost:3100
```

Auth is a single admin password from `ADMIN_PASSWORD` (in `dashboard/.env.local` or the
environment). If unset, a random password is generated and logged at startup. Config and
`mcp.json` edits show a "restart required" banner; the restart button signals the
supervisor started by `scripts/run-agent.sh` (it writes `.state/agent.pid` and respawns
the agent). Operating-manual and Skill edits apply to the next job without a restart.

**`.env` holds credentials and nothing else.** `open-agent.config.json` describes the
instance — the Vault, bounds, model, and the path to `mcp.json`.
`mcp.json` is the one extensible registry for every MCP server. It supports remote
Streamable HTTP and local stdio servers and names environment variables rather than
containing their secret values. With neither configuration file you get a Slack coworker
with a Vault and no connectors. See [docs/configuration.md](docs/configuration.md).

**Startup either runs or tells you exactly what is wrong.** A missing token or unreachable
connector is found before the first mention. MCP servers may add or remove tools without
blocking startup.

The instance keeps Session mappings, Schedules, and Thread-scoped approval grants under `.state/`. Conversations live on
Codex's disk and Notes live in the Vault. Deleting `sessions.json` makes every Thread start
over; deleting `schedules.json` permanently removes every configured Schedule.

## Scheduled work

Ask in the same conversational Slack style used for ordinary work:

> @open-agent Every weekday at 9 AM summarize new commits in org/repo and post in #engineering.

The coworker resolves an explicit timezone or defaults to the requesting user's Slack
timezone, validates the destination, and posts a team creation notice in the destination.
Every Occurrence starts a new top-level message there; progress, Write receipts, files, and
the final result stay in its Thread.

Manage Schedules conversationally: “list schedules”, “pause S-3”, “move S-3 to #platform”,
“run S-3 now”, or “delete S-3”. Anyone who can invoke the bot may manage any Schedule in
this version. Recurring work is limited to once per local calendar day; one-time reminders
may be sooner. Missed and overlapping Occurrences are skipped rather than caught up.

The Slack app requires `users:read` to use a creator's profile timezone. Add the scope and
reinstall the app when upgrading an existing workspace installation.

## Its memory is a folder of Markdown

Point `vault.notes` at a directory — an Obsidian vault, if you use one — and that is
where everything the coworker learns goes. **There is no other memory**: no hidden
store, no embedding index, nothing it believes that you cannot open in a text editor.
Edit a Note by hand and it respects your edit; delete one and the belief is gone.

The vault has two halves, and the split is a boundary rather than an arrangement:

```
vault/
  Notes/     the coworker reads and writes these — its memory
  Skills/    procedures you write for it, which it reads and cannot write
```

A **Skill** is how you teach it to do something without writing code: how to reach the
analytics replica, which command pulls the weekly export, what the output means. An
ordinary Markdown file, edited in the same Obsidian. It is told what Skills exist at the
start of every job and reads the one that applies.

It **cannot edit them**, and that is the point — a Skill it could rewrite would be a way
for something it read in one thread to put a command in front of a job in another. When it
finds a procedure has drifted it says so in the thread and writes a Note about it; the fix
is yours. A Skill names an environment variable where it needs a credential and never
contains one, and anything reached this way has **the credential as its only boundary**,
so scope it accordingly — see [docs/skills.md](docs/skills.md).

At the end of each job it decides for itself whether anything was worth remembering.
**Usually the answer is no** — a question answered is not something learned — and
writing nothing is the expected outcome rather than a failure. When there is something,
it searches the vault first and updates what is already there by preference, so the
vault grows rather than accumulating near-duplicates. There is no folder taxonomy: it
files alongside whatever arrangement it finds, so if you move things, your arrangement
is the one it follows.

**Every Note it creates, changes or deletes is written to the server-side Vault change
log with its diff**, including ones written by a shell command, because the record comes
from comparing the directory before and after rather than from what the engine said it
did. The append-only JSONL file is `<stateDir>/vault-changes.jsonl`; it keeps memory
bookkeeping out of the Slack conversation while preserving Thread and Job provenance for
operators. Fixing a wrong Note is still just correcting or deleting the file.

One file in the vault is different. `Root.md` is the map — hub links only, and it is
put in front of the coworker at the start of every job, which is what stops it
answering confidently while the note that settles the question sits unread. Because it
reaches every job in every thread, **anything in it that is not a wikilink with a short
label is stripped before the model sees it**, and you get told what was stripped. That
is deliberate and load-bearing rather than fussy: it is the only thing standing between
one poisoned job and every job after it ([ADR-0004](docs/adr/0004-root-note-is-links-only.md)).
It is otherwise an ordinary note — open it and rewrite it.

## What stops a runaway job

Every job has a per-Turn wall-clock timeout, defaulting to six hours and required to remain
below 24 hours. The Turn cap and token budget remain independently opt-in under `bounds`.
A job that hits a configured
limit is killed and says in the thread which limit stopped it, how far it had got, and
that whatever it had already done out in the world still stands.

Codex reports token usage only after a Turn ends, so a configured token budget can refuse
the next Turn but cannot interrupt one already spending. The wall-clock timeout is what can
interrupt a wedged Turn.

You can also stop a job yourself: **`@coworker stop`, and nothing else in the
message.** A mention that says anything more is a correction, not a kill switch.
Stopping kills the engine, but a shell command it had already launched can outlive it
— see [build/05](.scratch/slack-coworker/build/05-bounds-and-failure.md#the-limit-on-what-stop-means).

Four jobs run at once across the whole instance (`bounds.maxConcurrentJobs`); the rest wait
their turn and say so in their thread.

The closing pass that files notes has a bound of its own (`bounds.librarianTimeoutMs`, five
minutes). Hitting it abandons the tidying up and never fails the job — the work is done
and reported by then, and curation is best-effort.

## Mentioning it while it is already working

**One thread runs one job at a time.** Mention it again while a job is running and the
new message is acknowledged immediately and then picked up the moment the current job
finishes — in the same conversation, in the order the messages arrived. Other threads
are unaffected: they run their own jobs at the same time.

The cost is that **a correction waits too.** "@coworker stop, wrong repo" is a message
with words in it, so it queues rather than interrupting, and the coworker finishes the
wrong work before reading it. If you want it to drop what it is doing, that is
`@coworker stop` on its own — which also throws away anything queued behind the job,
and says in the thread what it threw away.

It runs against the `codex` on your `PATH` — the installation you log in with and
upgrade — falling back to the copy in `node_modules` if there is none, and reporting
which version it found at startup. v1 pins no version deliberately (see
[the spec](.scratch/slack-coworker/spec.md#runtime-configuration)), so that report is
how you find out what changed when something breaks overnight.

## Tests

```bash
pnpm test          # the default suite: fast, no network, no Codex
pnpm typecheck
pnpm test:contract # slow, opt-in: runs a real Codex App Server
```

`pnpm test` drives the whole coworker through one seam at the top — a fake Slack, a
scripted engine, a controllable clock, and real files in a temporary location for the
Vault and the Session store — and asserts on three things: the Slack calls made, the
files on disk, and the prompt the engine received. A test should still pass if the
internals were rewritten, and should fail if our experience changed.

**`pnpm test:contract` is how a Codex version bump gets validated.** It runs a real
`codex app-server` and asserts the things a fake cannot honestly assert — that stdio
JSON-RPC requests hold exact actions before execution and that events still translate into
the wrapper vocabulary. It costs tokens,
needs working Codex credentials, and is excluded from `pnpm test`. Because there is
no version pin, run it against whatever version is installed rather than only at a
deliberate bump: it is the only thing standing between an upstream alpha and an
instance that is silently broken.

## The coworker's operating manual

[`assets/operating-manual.md`](assets/operating-manual.md) is the coworker's persona
and standing rules. It is copied into every Job's workspace as `AGENTS.md` before the
engine starts, on every run — so adjusting how the coworker behaves means editing
that file, and a Job cannot rewrite its own instructions for the next one.
