import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  Codex,
  type CodexOptions,
  type CommandExecutionItem,
  type FileChangeItem,
  type McpToolCallItem,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { disabledToolsFor } from "../mcp/denylist.ts";
import type {
  ActivityStatus,
  Engine,
  EngineEvent,
  EngineSession,
  RunOptions,
  SandboxPosture,
  SessionOptions,
} from "../ports/engine.ts";
import type { McpServerConfig } from "../ports/mcp.ts";
import { buildSandboxEnv, prepareSandboxRoot } from "./sandbox-env.ts";

/**
 * The Codex adapter — the **only** module in this codebase that imports
 * `@openai/codex-sdk` or knows the shape of a Codex event (ADR-0001).
 *
 * Everything it does is translation: process lifecycle, Session identity, and
 * turning `codex exec`'s JSONL event stream into the wrapper's own vocabulary. If
 * this project ever moves to `app-server`, this file is the rewrite.
 *
 * Two properties of `exec` that the rest of the system is built around, and which
 * live here because they are the engine's:
 *
 * - **It cannot ask permission.** `codex exec` hard-codes `approval_policy: Never`.
 *   There is no approval channel to surface, which is why the Thread's audit record
 *   is the accountability story instead.
 * - **Progress is item-level.** `exec` deliberately drops every delta notification,
 *   so there is nothing finer to translate than whole items. Only the todo list
 *   updates mid-item.
 */

export interface CodexEngineOptions {
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** An explicit `codex` binary, when the one on `PATH` is not the one to run. */
  codexPath?: string | undefined;
  /**
   * The disk-backed root a Job's temporary files and package caches are pointed at, so a
   * bulk install cannot fill the host's shared (and often RAM-backed) `/tmp`. When unset,
   * the subprocess environment is left exactly as the wrapper inherited it — the previous
   * behaviour, kept for a caller that has no better location to offer. See `sandbox-env.ts`.
   */
  sandboxRoot?: string | undefined;
  /**
   * The wrapper's own environment. The credential store names variables in it, so it is
   * carried into the subprocess rather than replaced. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * The MCP connectors, which Codex reads as its own configuration (ADR-0005).
   *
   * The wrapper is not in the tool path: it does not proxy these calls, it *generates the
   * configuration that grants them* — including each server's `disabled_tools`, which is
   * the whole of layer 2. Codex Apps are disabled separately so they cannot introduce
   * connectors with credentials outside this registry. See {@link engineConfig}.
   */
  mcpServers?: readonly McpServerConfig[];
}

/**
 * How a Job is sandboxed. Stated once, here, because this is the module that configures it.
 *
 * `workspace-write` because the agent must write its workspace and the Notes; network on
 * because the work is Linear, GitHub, and the web; `execpolicy` unrestricted because once
 * the credential is the boundary, per-command rules buy little and cost a lot of tuning
 * ([ADR-0002](../../docs/adr/0002-unattended-action-boundary.md)). `danger-full-access`
 * would give up the filesystem boundary for nothing.
 */
const SANDBOX = {
  // Typed as the SDK's own union rather than as `string`, so that a Codex which renames a
  // sandbox mode stops this compiling instead of passing an unknown one through.
  mode: "workspace-write",
  networkEnabled: true,
  // Nothing is configured, which is what "unrestricted" means here — Codex applies no
  // per-command rules unless it is given some, and v1 gives it none.
  execPolicy: "unrestricted (no rules configured)",
} satisfies SandboxPosture & { mode: SandboxMode };

/**
 * Asynchronous because the binary is resolved once, up front: v1 runs against
 * whatever Codex is installed, so which binary that is and what version it reports
 * are answers the instance has to go and get rather than assume.
 */
export async function createCodexEngine(options: CodexEngineOptions): Promise<Engine> {
  const binary = await resolveCodexBinary(options.codexPath);
  const generated = engineConfig(options.mcpServers ?? []);
  const baseEnv = options.env ?? process.env;
  const root = options.sandboxRoot;
  if (root !== undefined) prepareSandboxRoot(root);
  const codex = new Codex({
    ...(binary.path ? { codexPathOverride: binary.path } : {}),
    // Flattened by the SDK into repeated `--config key=value` overrides, so the whole
    // `config.toml` surface is reachable — and so the deny-list this instance generates
    // reaches the subprocess without a file anybody has to keep in sync.
    config: generated,
    // The SDK replaces the subprocess environment wholesale when this is set, so `baseEnv`
    // is spread in explicitly and the credential variables survive. When no disk-backed
    // root was offered, the environment is left alone and the engine keeps its own default.
    ...(root === undefined ? {} : { env: buildSandboxEnv(baseEnv, root) }),
  });

  const threadOptions = (session: SessionOptions): ThreadOptions => ({
    model: options.model,
    modelReasoningEffort: options.reasoningEffort,
    // ADR-0002 layer 2, and taken from {@link SANDBOX} rather than restated: startup
    // *reports* that posture, so a literal here that drifted from it would make the report
    // describe a sandbox no Job is actually in.
    sandboxMode: SANDBOX.mode,
    networkAccessEnabled: SANDBOX.networkEnabled,
    workingDirectory: session.workingDirectory,
    additionalDirectories: [...(session.writableDirectories ?? [])],
    // A Job's workspace is a plain directory, not a checkout.
    skipGitRepoCheck: true,
  });

  return {
    version: async () => binary.version,
    sandbox: SANDBOX,

    startSession(session: SessionOptions): EngineSession {
      return codexSession(codex.startThread(threadOptions(session)));
    },

    /**
     * The same call to Codex as {@link startSession} — a fresh thread — and the whole
     * difference is that its identifier goes nowhere. Codex will still write a rollout
     * for it under its own home, because `exec` has no ephemeral mode worth using
     * (`--ephemeral` disables persistence entirely, including for Sessions that need
     * it), so what makes this one-off is that nothing ever asks to resume it.
     */
    startOneOffSession(session: SessionOptions): EngineSession {
      return codexSession(codex.startThread(threadOptions(session)));
    },

    /**
     * Codex persists each Session as an append-only rollout under its own home, so
     * resuming needs nothing but the identifier — the conversation is already there.
     * The options are passed again because they describe *this* Job's sandbox, which
     * is the same shape but a fresh subprocess.
     */
    resumeSession(sessionId: string, session: SessionOptions): EngineSession {
      return codexSession(codex.resumeThread(sessionId, threadOptions(session)));
    },
  };
}

/**
 * The complete external-tool configuration handed to Codex.
 *
 * Codex Apps are enabled by default. They are a separate connector surface from
 * `mcp_servers`, use their own authorizations, and remain available when MCP configuration
 * is supplied. Disable them explicitly: ADR-0005 says the project-owned MCP registry is the
 * one source of connectors, and an inherited `codex_apps` GitHub tool would bypass both its
 * credential and repository expectations.
 *
 * The configured MCP servers still become `[mcp_servers.<id>]` overrides. This is where
 * layer 2 of the action boundary lands: the wrapper cannot refuse or inspect a tool call,
 * so `disabled_tools` must be part of the configuration that grants the tool.
 *
 * - **`bearer_token_env_var`, never the token.** Codex resolves it from its own process
 *   environment, so the credential is never written into a config value that would end up in
 *   a `--config` argument — and therefore never in this process's command line, where `ps`
 *   would show it to every user on the machine.
 * - **No empty `mcp_servers` table.** When this instance has no MCP connectors, omit that
 *   key rather than shadowing a self-hoster's own MCP configuration. Apps remain disabled
 *   either way because they are not part of that explicit registry.
 */
export function engineConfig(
  servers: readonly McpServerConfig[],
): NonNullable<CodexOptions["config"]> {
  const mcp = mcpServerConfig(servers);
  return {
    // Jobs run from Slack without an interactive approval channel. Leaving this to the
    // operator's Codex config makes every write-capable MCP call look cancelled when that
    // config asks for confirmation, even though the Job's action boundary already decides
    // which tools exist via disabled_tools.
    approval_policy: "never",
    features: { apps: false },
    ...(mcp ?? {}),
  };
}

function mcpServerConfig(
  servers: readonly McpServerConfig[],
): NonNullable<CodexOptions["config"]> | undefined {
  if (servers.length === 0) return undefined;
  return {
    mcp_servers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        server.transport === "http"
          ? {
              url: server.url,
              ...(server.bearerTokenEnvVar === undefined
                ? {}
                : { bearer_token_env_var: server.bearerTokenEnvVar }),
              ...(Object.keys(server.httpHeaders).length === 0
                ? {}
                : { http_headers: server.httpHeaders }),
              ...(Object.keys(server.envHttpHeaders).length === 0
                ? {}
                : { env_http_headers: server.envHttpHeaders }),
              enabled: server.enabled,
              disabled_tools: disabledToolsFor(server),
              ...(server.defaultToolsApprovalMode === undefined
                ? {}
                : { default_tools_approval_mode: server.defaultToolsApprovalMode }),
              ...(server.startupTimeoutSec === undefined
                ? {}
                : { startup_timeout_sec: server.startupTimeoutSec }),
              ...(server.toolTimeoutSec === undefined
                ? {}
                : { tool_timeout_sec: server.toolTimeoutSec }),
            }
          : {
              command: server.command,
              args: [...server.args],
              ...(Object.keys(server.env).length === 0 ? {} : { env: server.env }),
              ...(server.envVars.length === 0 ? {} : { env_vars: [...server.envVars] }),
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              enabled: server.enabled,
              disabled_tools: disabledToolsFor(server),
              ...(server.defaultToolsApprovalMode === undefined
                ? {}
                : { default_tools_approval_mode: server.defaultToolsApprovalMode }),
              ...(server.startupTimeoutSec === undefined
                ? {}
                : { startup_timeout_sec: server.startupTimeoutSec }),
              ...(server.toolTimeoutSec === undefined
                ? {}
                : { tool_timeout_sec: server.toolTimeoutSec }),
            },
      ]),
    ),
  };
}

function codexSession(thread: Thread): EngineSession {
  return {
    get id() {
      return thread.id;
    },
    run(prompt: string, options?: RunOptions): AsyncIterable<EngineEvent> {
      return (async function* () {
        // The SDK spawns `codex exec` with this signal, so aborting it sends the
        // process a signal rather than just abandoning its output. Closing this
        // generator early — a `break` in the Job runner — kills it too, because the
        // SDK kills the child when its own stream is closed. Both routes matter: one
        // is the bound firing, the other is the Job deciding it has heard enough.
        const signal = options?.signal;
        const input =
          options?.imagePaths === undefined || options.imagePaths.length === 0
            ? prompt
            : [
                { type: "text" as const, text: prompt },
                ...options.imagePaths.map((imagePath) => ({
                  type: "local_image" as const,
                  path: imagePath,
                })),
              ];
        const { events } = await thread.runStreamed(input, signal ? { signal } : {});
        for await (const event of events) {
          yield* translate(event);
        }
      })();
    },
  };
}

/**
 * One Codex event in, zero or more wrapper events out.
 *
 * Zero is a real case: `item.started` for an agent message carries no text worth
 * reporting, and reasoning summaries are noise until something asks for them.
 */
function translate(event: ThreadEvent): EngineEvent[] {
  switch (event.type) {
    case "thread.started":
      return [{ type: "session-started", sessionId: event.thread_id }];
    case "turn.started":
      return [{ type: "turn-started" }];
    case "turn.completed":
      return [
        {
          type: "turn-completed",
          usage: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          },
        },
      ];
    case "turn.failed":
      return [{ type: "turn-failed", message: event.error.message }];
    case "error":
      return [{ type: "engine-error", message: event.message }];
    case "item.started":
    case "item.updated":
      return translateItem(event.item, "in-progress");
    case "item.completed":
      return translateItem(event.item, "completed");
    default:
      // An unrecognised event from a newer Codex. Dropping it is right — the
      // alternative is crashing a Job over an event nothing reads.
      return [];
  }
}

function translateItem(item: ThreadItem, status: ActivityStatus): EngineEvent[] {
  // Whole items only — `exec` has no delta stream, so an item that has merely
  // started carries nothing worth reporting for the text-shaped kinds.
  const terminal = status === "completed";

  switch (item.type) {
    case "agent_message":
      return terminal ? [{ type: "message", text: item.text }] : [];
    case "reasoning":
      return terminal ? [{ type: "reasoning", text: item.text }] : [];
    case "todo_list":
      return [
        {
          type: "plan",
          steps: item.items.map((step) => ({ text: step.text, completed: step.completed })),
        },
      ];
    case "command_execution":
      return [
        {
          type: "command",
          command: item.command,
          status: statusOf(item.status),
          output: item.aggregated_output,
          exitCode: item.exit_code,
        },
      ];
    case "file_change":
      return [
        {
          type: "file-change",
          changes: item.changes.map((change) => ({ path: change.path, kind: change.kind })),
          status: statusOf(item.status),
        },
      ];
    case "mcp_tool_call":
      return [
        {
          type: "tool-call",
          server: item.server,
          tool: item.tool,
          status: statusOf(item.status),
          error: item.error?.message,
          result: resultTextOf(item),
        },
      ];
    case "web_search":
      return terminal ? [{ type: "web-search", query: item.query }] : [];
    case "error":
      return [{ type: "engine-error", message: item.message }];
    default:
      return [];
  }
}

/**
 * A tool result as one block of text, or nothing.
 *
 * Only the text blocks are read. An MCP result may also carry images and structured
 * content, and neither is worth translating for the one thing the wrapper does with a
 * result: find the identifier or URL of what the tool just created, so the Write's
 * audit record can link to it.
 */
function resultTextOf(item: McpToolCallItem): string | undefined {
  const text = (item.result?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

/**
 * Deliberately typed against the SDK's own status unions rather than `string`: if
 * upstream renames a status, this stops compiling instead of quietly reporting the
 * wrong one. Catching that at build time is most of what the adapter seam is for.
 */
function statusOf(
  itemStatus: CommandExecutionItem["status"] | FileChangeItem["status"] | McpToolCallItem["status"],
): ActivityStatus {
  switch (itemStatus) {
    case "in_progress":
      return "in-progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

interface ResolvedCodex {
  /** Passed to the SDK as `codexPathOverride`; undefined means use the vendored one. */
  path: string | undefined;
  version: string;
}

/**
 * Which Codex will actually run, and what version it is.
 *
 * v1 deliberately pins nothing: **the instance runs against whatever is installed.**
 * A self-hoster has to install Codex to log in at all, and that installation — the
 * one they upgrade, and the one whose alphas will surprise them — is the one to use.
 * So a `codex` on `PATH` wins, and the copy vendored into `node_modules` is the
 * fallback for a deployment that has nothing else.
 *
 * This is why the drift warning at startup is worth having: the two can differ, and
 * when they do it is the installed one that decides how the coworker behaves.
 */
async function resolveCodexBinary(explicitPath: string | undefined): Promise<ResolvedCodex> {
  if (explicitPath) {
    return { path: explicitPath, version: await codexVersionOf(explicitPath) };
  }

  try {
    // `spawn` resolves a bare command against PATH, so this asks the installed CLI.
    return { path: "codex", version: await codexVersionOf("codex") };
  } catch {
    return { path: undefined, version: await vendoredCodexVersion() };
  }
}

async function codexVersionOf(binary: string): Promise<string> {
  const { stdout } = await promisify(execFile)(binary, ["--version"]);
  // `codex --version` prints e.g. `codex-cli 0.145.0`.
  return stdout.trim().replace(/^codex-cli\s+/, "");
}

/** The SDK loads its binary out of `@openai/codex`, so that package's version is it. */
async function vendoredCodexVersion(): Promise<string> {
  const manifestPath = createRequire(import.meta.url).resolve("@openai/codex/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string };
  if (!manifest.version) {
    throw new Error(`Could not read a Codex version from ${manifestPath}`);
  }
  return manifest.version;
}
