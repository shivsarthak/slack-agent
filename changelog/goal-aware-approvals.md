# Goal-aware approvals

This update adds a goal-aware Approval Gate to open-agent. Jobs now run through a
supervised Codex App Server process, allowing open-agent to hold an exact action before it
runs and ask for a decision in the originating Slack Thread.

## What changed

- `coworker` is the new default approval mode. Proven reads and ordinary reversible work
  within the delegated goal continue automatically. Consequential, out-of-goal, and
  unclassified actions pause for approval.
- Approval requests offer **Approve once**, **Allow similar in this Thread**, and **Deny**.
  Only the person who delegated the Job, or the creator of a Schedule, can decide.
- Similar-action grants are narrowly scoped to one Thread and persist in
  `<stateDir>/approvals.json`. Pending approvals are invalidated when a Job stops, times
  out, the engine exits, or the service restarts.
- `external-writes` is available for operators who want unexempted external mutations to
  require approval. Explicit `off` mode retains the previous unattended behavior.
- Guarded modes start from a read-only sandbox with shell network access disabled. Command,
  file-change, permission, and enabled MCP action requests are intercepted before capability
  is expanded.
- Natural-language approval policy and deterministic `allow`, `ask`, or `deny` rules can be
  configured under `approvals`. Fixed safety boundaries and disabled MCP tools cannot be
  weakened by policy or grants.
- The Job transport changed from `codex exec` through `@openai/codex-sdk` to
  `codex app-server` over stdio JSON-RPC. The unused SDK dependency was removed; the pinned
  `@openai/codex` package remains the vendored fallback.
- Startup now reports the active approval posture, and the contract suite validates the
  App Server approval round trip.

## Updating from the previous version

1. Stop the running open-agent process cleanly and update the checkout to this version.
2. Run `pnpm install` to apply the lockfile change and remove `@openai/codex-sdk`.
3. In the Slack app settings, enable **Interactivity**. Approval button events use the
   existing Socket Mode connection, so no public request URL or new OAuth scope is needed.
4. Decide which approval posture to use. If `approvals` is omitted, the service now defaults
   to `coworker`:

   ```json
   "approvals": {
     "mode": "coworker",
     "rules": []
   }
   ```

   To preserve the old unattended, workspace-write and network-enabled behavior, add this
   before restarting:

   ```json
   "approvals": {
     "mode": "off",
     "rules": []
   }
   ```

   Use `external-writes` instead when every external mutation should pause unless a narrow
   rule or Thread grant allows it. See [configuration](../docs/configuration.md#approvals)
   for policy and rule syntax.
5. Ensure the account running open-agent can write to `stateDir`. The service creates
   `approvals.json` there with restrictive file permissions; existing session and schedule
   state files remain in place.
6. Run `pnpm typecheck` and `pnpm test`. If the machine uses a separately installed `codex`
   from `PATH`, also run `pnpm test:contract` to confirm that its experimental App Server
   protocol matches this version. Otherwise open-agent falls back to the pinned vendored
   Codex binary.
7. Restart open-agent and confirm preflight reports the intended `Approval Gate` mode. In a
   test Thread, request an action that requires approval and verify that the delegating user
   can use all three buttons.

No manual state migration is required. Existing Sessions and Schedules are retained, and
the approval store is created on first use. Approval requests that were pending before a
restart cannot be resumed and must be requested again by a new Job.

