---
status: accepted
---

# The repository is the action boundary, not the tool policy

**Amended by [ADR-0008](0008-goal-aware-approval-gate.md).** In guarded modes the Approval
Gate is the intent-aware pre-execution boundary. The deny-list, credential scope, repository
protection, and local hook below remain independent defence in depth. The historical
unattended posture remains available only through explicit `off` mode.

The coworker acts unattended ([ADR-0001](0001-codex-cli-via-exec-and-sdk.md)) while reading untrusted input from Slack, GitHub, and Linear, so there is no human between a crafted issue comment and an action. We bound this in three layers: the coworker may do **anything a human can undo after the fact** but not the known irreversible actions (`merge_pull_request`, `merge_diff`, `submit_diff_review`, `delete_file`, and Linear's known delete tools); those exact tools are enforced as a **deny-list** for MCP servers; and because the agent has shell access and the token doubles as the git password, the irreversible actions are made impossible **server-side by branch protection on the default branch** — the tool policy is defence-in-depth, not the boundary.

**Amended by [ADR-0007](0007-github-is-an-official-mcp-server.md): GitHub returns to layer 2.**
Its official MCP server is configured with `merge_pull_request` and `delete_file` disabled.
A fine-grained token limits repository reach. Shell access can still bypass the MCP tool
surface, so branch protection remains the server-side boundary rather than the deny-list.

**Amended 2026-07-29: MCP tool inventories are deliberately not pinned.** An enabled
connector is probed for connectivity and its current tool count is reported, but tools may
appear or disappear without preventing startup. The previous pin made routine upstream
evolution an availability failure and required operators to continually approve tool-list
churn. Open-agent now keeps a small exact-name deny floor for known irreversible tools and
lets each server add exact names through `disabledTools`. A newly introduced destructive
verb is therefore not automatically blocked; that risk is accepted in favour of a forgiving,
extensible connector system.

**Amended.** The third layer was originally *credential scoping* — a fine-grained PAT granting pull-request write without merge. The project has since ruled out fine-grained PATs, and a classic PAT's `repo` scope is all-or-nothing: it cannot separate merge from pull-request write. The boundary therefore moves from the credential to the repository, which is where it remains enforceable with the token type in use.

## The layers as built

1. **Policy** — anything undoable is permitted; the irreversible list above is not.
2. **Exact-name deny-list** — known irreversible MCP tools plus per-server
   `disabledTools`. There is no inventory pin and new tools are allowed automatically.
   GitHub and Linear both use this layer through MCP.
3. **Branch protection on the default branch** — require a pull request before merging, require at least one approving review, and **disallow bypassing**, administrators included. Merge and force-push to the default branch then fail server-side for every actor, the coworker's token among them.

GitHub uses a **fine-grained PAT** restricted to selected repositories and only the
permissions needed for repository contents, issues, and pull requests. Administration,
organisation management, and workflow modification are withheld.

## Considered options

- **Accept the bypass explicitly** — document that the deny-list is the only control and that shell access defeats it. Rejected: it gives up the claim that irreversible actions are impossible, leaving "a prompt injection that says use `curl`" unmitigated.
- **Deploy key for git, token withheld from the shell** — an SSH deploy key for push, the PAT only in MCP server configuration. Rejected for v1 as unverified: Codex's sandbox permits broad filesystem reads, so whether the agent can simply read the config is an open question, and the whole design would rest on it being closed.
- **Sandbox egress allow-listing** — rejected as ineffective against this threat. The merge endpoint is on the same host as every legitimate read, so host-level allow-listing cannot distinguish `PUT /pulls/N/merge` from `GET /pulls/N`. Only a filtering proxy could, which is a component to build and secure.
- **A fine-grained PAT scoped to pull-request write without merge** — the original decision, ruled out by the project.

## Consequences

- **The guarantee is per-repository, opt-in, and plan-gated.** An unprotected repository silently loses it. This is the sharp edge of the amendment: the setup guide must treat protection as strongly recommended, and preflight verifies it on every configured repository — but **warns rather than refusing**. Refusing was the original position; it was given up because Check B showed protection is unpurchasable-without-Pro on private repositories, so refusal would lock out plausibly the modal self-hoster over a condition they cannot fix. The trade is explicit: **the instance will knowingly run without layer 3**, and layers 1 and 2 plus the local hook are then the whole mitigation rather than a supplement. Decided on [build/10](../../.scratch/slack-coworker/build/10-branch-protection-verification.md).
- ~~**Conditional on a verification.**~~ **Both checks are now run** ([ticket 05](../../.scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md)); the results split.
  - **Check A passes.** A ruleset with `bypass_actors: []` genuinely binds a repository **admin**: merge returned `405 Repository rule violations found`, and force-push was rejected with `GH013 … Cannot force-push to this branch`. Layer 3 is sound where it can be enabled, and the ADR does not reopen.
  - **Check B fails, on both mechanisms.** Classic branch protection *and* rulesets are identically plan-gated on private repositories — both return `403 Upgrade to GitHub Pro or make this repository public`. Rulesets were the hypothesised escape hatch; they are not one. **Layer 3 therefore does not exist for a self-hoster on a free plan working in private repositories**, which is plausibly the modal user. For them the boundary is layers 1 and 2 alone — the same posture this ADR already calls the weaker half when describing Linear.
  - **Preflight verifies via two calls:** `GET /repos/{o}/{r}/rules/branches/{default_branch}` for effective rules (mechanism-agnostic, covers classic protection and rulesets alike), then `GET /repos/{o}/{r}/rulesets/{id}` for **`current_user_can_bypass`**, observed as `"never"`. That field answers preflight's actual question directly, and bypass state is *not* present on the `/rules` response.
- **Local git hooks sit inside layer 2, not beside layer 3.** A repo-managed `pre-push` hook is worth shipping — it is the only mechanism that covers free private repositories, non-default branches, and repositories the self-hoster does not administer. But it is **not a boundary**: `--no-verify` skips it unconditionally, `core.hooksPath` can be overridden per invocation, `workspace-write` lets the agent edit the hook itself, and the PAT in the environment reaches the merge endpoint over `curl` without touching git at all. It guards against accident and drift, which are the common failure modes, and contributes nothing against the prompt-injection case this ADR is written for. Implementation must be **stdin-driven** — judging the destination ref and `git merge-base --is-ancestor` — because the obvious command-line-inspecting version is defeated by `git push origin HEAD:main` and by `+refspec` forcing. Measured in [`research/local-git-enforcement.md`](../../.scratch/slack-coworker/research/local-git-enforcement.md).
- **Force-push to feature branches remains reachable.** Those are the coworker's own branches; losing one costs a redo. Accepted.
- **`delete_file` is not actually irreversible** and stays on the deny-list only as defence-in-depth — over git it is an ordinary commit, recoverable from history.
- **GitHub search follows the official server and token capabilities.** If a narrowly scoped
  token cannot perform a search, the project accepts that limitation rather than broadening
  the credential or creating a special authentication path.
- **MCP annotations are not a portable safety primitive.** Measured: Linear flags 18 of 57 tools destructive; GitHub flags exactly one (`delete_file`) and leaves `merge_pull_request` and `push_files` unflagged. The deny-list is therefore hand-curated.
- **Linear has no equivalent third layer.** Its API key carries whatever the user can do, and there is no repository-shaped thing to protect, so the Linear half runs on layers 1 and 2 alone. That was equally true before this amendment, but it is now the weaker half and should be documented as such.
- **Linear's `save_*` tools are upserts.** "May create but not modify" is not expressible at tool granularity — only at argument granularity — so that line is deliberately not drawn. GitHub splits create/update; Linear does not. Do not assume symmetry between connectors.
- **Guarded Jobs start read-only with shell network disabled.** Exact capability expansions
  are intercepted by App Server. Explicit `off` mode retains the former `workspace-write`,
  network-enabled posture.
- **Inventory evolution favours availability.** New tools become available without an
  operator approval step. Add a tool to `disabledTools` when a connector-specific exclusion
  is required.
- **Residual risk is accepted, not eliminated.** Anything within the token's power on an unprotected surface is reachable by prompt injection. Non-destructive but embarrassing actions are fully available and recovery is manual.

Decided in [ticket 12](../../.scratch/slack-coworker/issues/12-blast-radius.md); amended when fine-grained PATs were ruled out. Inventories measured in [ticket 05](../../.scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md).
