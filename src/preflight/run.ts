import { RECORDED_CODEX_VERSION, type Config } from "../config.ts";
import { reasonFor } from "../failure.ts";
import type { Engine } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import type { McpInventoryProber } from "../ports/mcp.ts";
import type { RepositoryProtectionProbe } from "../ports/repositories.ts";
import type { SlackClient } from "../ports/slack.ts";
import { readRootNote, rootNoteConcerns, ROOT_NOTE_FILENAME } from "../vault/root.ts";
import { checkConnectors } from "./connectors.ts";
import { checkSkills } from "./skills.ts";

/**
 * What the instance checks before it accepts its first mention.
 *
 * The brief is one sentence: **a self-hoster starts the instance and either it runs or it
 * tells them exactly what is wrong.** Missing credentials, engine drift, and unreachable
 * MCP servers are found here with somebody watching rather than inside an unattended Job.
 *
 * Two severities, and the line between them is load-bearing:
 *
 * - **A report** describes an instance that will work. Version drift, the repository list,
 *   the bounds, the sandbox posture, a Root note full of prose. Some of these are warnings,
 *   which means "this will behave in a way you may not have intended".
 * - **A refusal** describes an instance that cannot deliver its configured capability or
 *   structural guarantees, such as an unreachable connector or writable Skills directory.
 *
 * Order matters only in one respect: the cheap local checks come before the network ones, so
 * a self-hoster with three things wrong does not have to wait on a connector round-trip to
 * learn about the first of them.
 */
export async function runPreflight(deps: {
  config: Config;
  engine: Engine;
  slack: SlackClient;
  inventoryProber: McpInventoryProber;
  repositoryProtection: RepositoryProtectionProbe;
  log: Logger;
  /**
   * The credential store. Named credentials are resolved out of it, never guessed.
   *
   * Required rather than defaulted to `process.env`, and passed down to the prober from the
   * same place: two components each falling back to the real environment is how a check and
   * the thing it is checking end up reading different credentials.
   */
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  deps.log.info(`Configuration: ${deps.config.source}`);
  deps.log.info(`MCP configuration: ${deps.config.mcpConfigSource}`);

  await checkEngine(deps);
  reportApprovals(deps);
  reportBounds(deps);
  await reportVault(deps);
  await checkSkills(deps);
  await checkSlack(deps);
  await checkConnectors(deps);
  await checkRepositories(deps);
}

function reportApprovals(deps: { config: Config; log: Logger }): void {
  const approval = deps.config.approvals;
  deps.log.info(
    `Approval Gate: ${approval.mode}; natural-language policy ${approval.policy ? "configured" : "absent"}; ` +
      `${approval.rules.length} deterministic rule(s). ` +
      (approval.mode === "off"
        ? "Interception is disabled explicitly."
        : `Shell capability expansion and all ${deps.config.mcpServers.filter((server) => server.enabled).length} enabled MCP server(s) are approval-intercepted.`),
  );
}

async function checkRepositories(deps: {
  config: Config;
  repositoryProtection: RepositoryProtectionProbe;
  log: Logger;
}): Promise<void> {
  for (const repository of deps.config.repositories) {
    const protection = await deps.repositoryProtection.check(repository);
    if (protection.status === "protected") {
      deps.log.info(
        `Repository ${repository}: ${protection.defaultBranch} has the required server-side protection.`,
      );
      continue;
    }

    if (protection.status === "unprotectable") {
      deps.log.warn(
        `Repository ${repository}: default branch ${protection.defaultBranch} is unprotectable ` +
          `on this plan (${protection.reason}). The instance will run without layer 3; the ` +
          "MCP deny-list and local pre-push hook are weaker defence-in-depth.",
      );
      continue;
    }

    deps.log.warn(
      `Repository ${repository}: default branch ${protection.defaultBranch} is unprotected ` +
        `(fixable). Missing: ${protection.missing.join(", ")}. Enable the missing repository ` +
        "rules. The instance will continue with only the weaker MCP deny-list and local " +
        "pre-push hook.",
    );
  }
}

/**
 * The engine: which Codex is installed, and how it sandboxes a Job.
 *
 * v1 ships **no version pin**: the instance runs against whatever Codex is installed,
 * records the version, and warns when it has drifted from the version this project was
 * tested against. That report is not optional — Codex ships multiple alphas a day and has
 * already removed flags a wrapper would plausibly depend on, so "it broke overnight and
 * nobody can see why" is the failure mode this exists to make visible.
 */
async function checkEngine(deps: { engine: Engine; log: Logger }): Promise<void> {
  const engineVersion = await deps.engine.version();
  deps.log.info(`Codex version ${engineVersion} (recorded: ${RECORDED_CODEX_VERSION})`);
  if (engineVersion !== RECORDED_CODEX_VERSION) {
    deps.log.warn(
      `The installed Codex is ${engineVersion}, but this project was built and tested ` +
        `against ${RECORDED_CODEX_VERSION}. v1 pins no version, so the instance will run ` +
        "anyway — but if it behaves strangely, this is the first thing to suspect. " +
        "Run `pnpm test:contract` to check the engine still behaves as expected.",
    );
  }

  // Read off the adapter that configures it rather than restated here, so this line cannot
  // drift from the sandbox a Job actually gets. It is layer 2 for everything the coworker
  // does by shell. MCP connector writes are recorded separately from this audit.
  const sandbox = deps.engine.sandbox;
  deps.log.info(
    `Sandbox: ${sandbox.mode}, network ${sandbox.networkEnabled ? "enabled" : "disabled"}, ` +
      `execpolicy ${sandbox.execPolicy}. The engine may write a Job's workspace and the ` +
      "Notes, and nothing else.",
  );
}

/** Report configured per-Job limits, including the ordinary no-limits default. */
function reportBounds(deps: { config: Config; log: Logger }): void {
  const bounds = deps.config.bounds;
  const configured = [
    bounds.turnTimeoutMs === undefined
      ? "no per-Turn timeout"
      : `${Math.round(bounds.turnTimeoutMs / 1000)}s per Turn`,
    bounds.maxTurnsPerJob === undefined
      ? "no Turn cap"
      : `${bounds.maxTurnsPerJob} Turns per Job`,
    bounds.tokenBudgetPerJob === undefined
      ? "no token budget"
      : `${bounds.tokenBudgetPerJob} tokens per Job`,
  ];
  deps.log.info(
    `Job bounds: ${configured.join(", ")}. ` +
      "A Job is stopped only when it hits a configured limit or a person asks it to stop.",
  );
}

/**
 * The Vault, and the Root note's grammar.
 *
 * Said once at startup as well as once per Job, because the two readers are different
 * people at different moments. A per-Job warning reaches whoever is watching the logs
 * while a Job runs; this reaches the person who has just edited their Vault and
 * restarted, which is exactly when a Root note full of prose gets written.
 */
async function reportVault(deps: { config: Config; log: Logger }): Promise<void> {
  const root = await readRootNote(deps.config.notesDir);
  deps.log.info(
    root.exists
      ? `Vault: ${deps.config.notesDir} — Root note has ${root.links.length} hub link(s)`
      : `Vault: ${deps.config.notesDir} — no ${ROOT_NOTE_FILENAME} yet, so nothing is on the map`,
  );
  for (const concern of rootNoteConcerns(root, deps.config.notesDir)) deps.log.warn(concern);
}

/**
 * Who Slack thinks the instance is.
 *
 * The bot token is otherwise not exercised until the first mention, where a bad one surfaces
 * as a Job that accepted work in a Thread and then said nothing — the exact failure this
 * whole file exists to move earlier. The workspace name is worth printing for a reason of
 * its own: a self-hoster with a test workspace and a real one will eventually start the
 * instance against the wrong tokens, and the moment to notice is now.
 */
async function checkSlack(deps: { slack: SlackClient; config: Config; log: Logger }): Promise<void> {
  let identity;
  try {
    identity = await deps.slack.identity();
  } catch (error) {
    throw new Error(
      `Slack rejected the bot token: ${reasonFor(error)}. The token came from the variable ` +
        `named in ${deps.config.source}; an invalid or revoked one has to stop startup, ` +
        "because the alternative is a Job that takes work in a Thread and cannot answer it.",
    );
  }
  try {
    await deps.slack.userTimezone(identity.botUserId);
  } catch (error) {
    throw new Error(
      `Slack user lookup failed: ${reasonFor(error)}. Scheduled work needs the users:read ` +
        "bot scope to default a Schedule to its creator's timezone. Add the scope, reinstall " +
        "the Slack app, and restart open-agent.",
    );
  }
  deps.log.info(
    `Slack: connected to ${identity.team} as ${identity.botUserId}. Mention that user in a ` +
      "channel it has been invited to. User timezone lookup is available.",
  );
}
