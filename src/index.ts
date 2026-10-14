import { loadConfig } from "./config.ts";
import { createCoworker } from "./coworker.ts";
import { createCodexEngine } from "./engine/codex.ts";
import { sandboxRoot } from "./engine/sandbox-env.ts";
import { createGitHubRepositoryProtectionProbe } from "./github/protection.ts";
import { createConsoleLogger } from "./log.ts";
import { createMcpInventoryProber } from "./mcp/prober.ts";
import { systemClock } from "./ports/clock.ts";
import { openSessionStore, sessionStoreFile } from "./sessions/store.ts";
import { createScheduleControl } from "./schedules/control.ts";
import { startScheduleMcpServer } from "./schedules/mcp.ts";
import { createScheduler } from "./schedules/scheduler.ts";
import { openScheduleStore, scheduleStoreFile, type ClaimedOccurrence } from "./schedules/store.ts";
import { createSlackApp, slackClientFor, subscribeToMentions } from "./slack/gateway.ts";
import { createMentionGateway } from "./slack/mentions.ts";

const log = createConsoleLogger();

async function main(): Promise<void> {
  log.banner();
  const config = await loadConfig();
  const app = createSlackApp(config);
  const slack = slackClientFor(app, config.slack.botToken);
  const scheduleStore = await openScheduleStore(scheduleStoreFile(config.stateDir));
  let dispatchSchedule: (claimed: ClaimedOccurrence) => Promise<void> = async () => {
    throw new Error("The scheduler is not ready yet");
  };
  let scheduleChanged: () => Promise<void> = async () => {};
  const scheduleControl = createScheduleControl({
    store: scheduleStore,
    slack,
    clock: systemClock,
    dispatch: (claimed) => dispatchSchedule(claimed),
    scheduleChanged: () => scheduleChanged(),
  });
  const scheduleMcp = await startScheduleMcpServer({
    control: scheduleControl,
    env: process.env,
    log,
  });
  const githubTokenVariable = config.repositoryProtectionTokenEnvVar;
  const githubToken =
    githubTokenVariable === undefined ? undefined : process.env[githubTokenVariable]?.trim();

  const coworker = createCoworker({
    config,
    slack,
    // The connectors reach the engine as *generated Codex configuration*, deny-list
    // included — the wrapper is not in the tool path (ADR-0005), so this is the only way
    // layer 2 exists at all.
    engine: await createCodexEngine({
      ...config.engine,
      mcpServers: [...config.mcpServers, scheduleMcp.config],
      // Bulk temporary data and package caches go to disk under the wrapper's own state,
      // never the host's shared `/tmp` (issue #26).
      sandboxRoot: sandboxRoot(config.stateDir),
      env: process.env,
    }),
    clock: systemClock,
    sessions: await openSessionStore({ filePath: sessionStoreFile(config.stateDir) }),
    // One credential store, handed to everything that reads one — so the check and the thing
    // it checks cannot end up reading different environments.
    inventoryProber: createMcpInventoryProber(process.env),
    repositoryProtection:
      githubToken === undefined || githubToken === ""
        ? {
            check: async (repository) => {
              throw new Error(
                `Repository ${repository} is configured, but the enabled GitHub MCP ` +
                  "connector does not name a usable bearer token. Branch protection cannot " +
                  "be verified.",
              );
            },
          }
        : createGitHubRepositoryProtectionProbe({ token: githubToken }),
    env: process.env,
    log,
  });

  // Before the first mention, not on it: a self-hoster should learn about a problem
  // at startup rather than from a Job that quietly did the wrong thing.
  await coworker.preflight();

  const scheduler = createScheduler({ store: scheduleStore, coworker, slack, clock: systemClock, log });
  dispatchSchedule = (claimed) => scheduler.dispatch(claimed);
  scheduleChanged = () => scheduler.wake();

  subscribeToMentions(app, createMentionGateway({ coworker, log }), log);
  await app.start();
  await scheduler.start();
  log.ready(`Listening for @-mentions over Socket Mode · Vault: ${config.notesDir}`);

  const stop = async (): Promise<void> => {
    scheduler.stop();
    await scheduleMcp.close();
    await app.stop();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
