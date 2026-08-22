import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ApprovalMode } from "../config.ts";
import { disabledToolsFor } from "../mcp/denylist.ts";
import type { ActivityStatus, Engine, EngineEvent, EngineSession, PlannedAction, RunOptions, SandboxPosture, SessionOptions } from "../ports/engine.ts";
import type { McpServerConfig } from "../ports/mcp.ts";

export interface CodexEngineOptions {
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  codexPath?: string | undefined;
  mcpServers?: readonly McpServerConfig[];
  approvalMode?: ApprovalMode | undefined;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const GUARDED_SANDBOX: SandboxPosture = { mode: "read-only", networkEnabled: false, execPolicy: "every capability expansion is intercepted" };
const OFF_SANDBOX: SandboxPosture = { mode: "workspace-write", networkEnabled: true, execPolicy: "unrestricted (approval mode off)" };

export async function createCodexEngine(options: CodexEngineOptions): Promise<Engine> {
  const binary = await resolveCodexBinary(options.codexPath);
  await verifyAppServerProtocol(binary.path ?? vendoredCodexPath());
  const guarded = (options.approvalMode ?? "coworker") !== "off";
  const rpc = new AppServer(binary.path ?? vendoredCodexPath(), engineConfig(options.mcpServers ?? [], options.approvalMode ?? "coworker"));
  await rpc.initialize();

  const session = (kind: "start" | "resume", sessionOptions: SessionOptions, existingId?: string, ephemeral = false): EngineSession => {
    let id: string | null = existingId ?? null;
    return {
      get id() { return id; },
      get locator() { return id; },
      run(prompt, runOptions = {}) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          const roots = [sessionOptions.workingDirectory, ...(sessionOptions.writableDirectories ?? [])];
          const common = {
            model: options.model,
            cwd: sessionOptions.workingDirectory,
            runtimeWorkspaceRoots: roots,
            approvalPolicy: guarded ? "on-request" : "never",
            approvalsReviewer: "user",
            sandbox: guarded ? "read-only" : "workspace-write",
            config: engineConfig(options.mcpServers ?? [], options.approvalMode ?? "coworker"),
          };
          const response = kind === "start"
            ? await rpc.request("thread/start", { ...common, ephemeral }) as { thread: { id: string } }
            : await rpc.request("thread/resume", { ...common, threadId: existingId }) as { thread: { id: string } };
          id = response.thread.id;
          yield { type: "session-started", sessionId: id, locator: id, engine: "codex" };
          const events = rpc.openTurn(id, runOptions.onApproval, sessionOptions.workingDirectory);
          let turnId: string | undefined;
          const abort = (): void => { if (turnId) void rpc.request("turn/interrupt", { threadId: id, turnId }).catch(() => {}); };
          if (runOptions.signal?.aborted) abort();
          else runOptions.signal?.addEventListener("abort", abort, { once: true });
          try {
            const input: Json[] = [{ type: "text", text: prompt, text_elements: [] }];
            for (const imagePath of runOptions.imagePaths ?? []) input.push({ type: "localImage", path: imagePath });
            const started = await rpc.request("turn/start", {
              threadId: id, input, cwd: sessionOptions.workingDirectory,
              runtimeWorkspaceRoots: roots,
              approvalPolicy: guarded ? "on-request" : "never",
              approvalsReviewer: "user",
              sandboxPolicy: guarded
                ? { type: "readOnly", networkAccess: false }
                : { type: "workspaceWrite", writableRoots: roots, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
              model: options.model, effort: options.reasoningEffort,
            }) as { turn: { id: string } };
            turnId = started.turn.id;
            if (runOptions.signal?.aborted) abort();
            for await (const event of events) {
              yield event;
              if (event.type === "turn-completed" || event.type === "turn-failed" || event.type === "engine-error") break;
            }
            if (runOptions.signal?.aborted) {
              const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error;
            }
          } finally {
            runOptions.signal?.removeEventListener("abort", abort);
            rpc.closeTurn(id);
          }
        })();
      },
    };
  };

  return {
    version: async () => binary.version,
    sandbox: guarded ? GUARDED_SANDBOX : OFF_SANDBOX,
    startSession: (options) => session("start", options),
    startOneOffSession: (options) => session("start", options, undefined, true),
    resumeSession: (id, options) => session("resume", options, id),
    close: () => rpc.close(),
  };
}

export function engineConfig(servers: readonly McpServerConfig[], mode: ApprovalMode = "coworker"): Record<string, Json> {
  const guarded = mode !== "off";
  const mcp = servers.length === 0 ? undefined : Object.fromEntries(servers.map((server) => [server.name, {
    ...(server.transport === "http" ? {
      url: server.url,
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      ...(Object.keys(server.httpHeaders).length ? { http_headers: server.httpHeaders } : {}),
      ...(Object.keys(server.envHttpHeaders).length ? { env_http_headers: server.envHttpHeaders } : {}),
    } : {
      command: server.command, args: [...server.args],
      ...(Object.keys(server.env).length ? { env: server.env } : {}),
      ...(server.envVars.length ? { env_vars: [...server.envVars] } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    }),
    enabled: server.enabled,
    disabled_tools: disabledToolsFor(server),
    default_tools_approval_mode: guarded ? "prompt" : (server.defaultToolsApprovalMode ?? "approve"),
    ...(server.startupTimeoutSec === undefined ? {} : { startup_timeout_sec: server.startupTimeoutSec }),
    ...(server.toolTimeoutSec === undefined ? {} : { tool_timeout_sec: server.toolTimeoutSec }),
  }]));
  return { approval_policy: guarded ? "on-request" : "never", approvals_reviewer: "user", features: { apps: false }, ...(mcp ? { mcp_servers: mcp } : {}) } as Record<string, Json>;
}

class AppServer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly turns = new Map<string, EventQueue>();
  private readonly handlers = new Map<string, RunOptions["onApproval"]>();
  private readonly workingDirectories = new Map<string, string>();
  private readonly turnControllers = new Map<string, AbortController>();
  private readonly activeMcp = new Map<string, { server: string; tool: string; arguments: unknown }>();
  private readonly usage = new Map<string, import("../ports/engine.ts").TokenUsage>();
  private stderr = "";
  private readonly binary: string;
  private readonly config: Record<string, Json>;
  constructor(binary: string, config: Record<string, Json>) { this.binary = binary; this.config = config; }

  async initialize(): Promise<void> {
    const args = ["app-server", "--stdio", "--strict-config", ...configArguments(this.config)];
    this.child = spawn(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("exit", (code, signal) => this.failAll(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try { this.receive(JSON.parse(line) as Message); }
      catch (error) { this.failAll(new Error(`Codex App Server emitted invalid JSON: ${String(error)}`)); }
    });
    await this.request("initialize", { clientInfo: { name: "open-agent", title: "open-agent", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify("initialized");
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  notify(method: string, params?: Record<string, unknown>): void { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    for (const controller of this.turnControllers.values()) controller.abort();
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }
  openTurn(threadId: string, handler: RunOptions["onApproval"], workingDirectory: string): EventQueue { const q = new EventQueue(); this.turns.set(threadId, q); this.handlers.set(threadId, handler); this.workingDirectories.set(threadId, workingDirectory); this.turnControllers.set(threadId, new AbortController()); return q; }
  closeTurn(threadId: string): void { this.turns.delete(threadId); this.handlers.delete(threadId); this.workingDirectories.delete(threadId); this.turnControllers.delete(threadId); }

  private send(message: Message): void {
    if (!this.child || !this.child.stdin.writable) throw new Error("Codex App Server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(message: Message): void {
    if (message.method && message.id !== undefined) { void this.serverRequest(message); return; }
    if (message.id !== undefined) {
      const id = Number(message.id); const pending = this.waiting.get(id); if (!pending) return; this.waiting.delete(id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      return;
    }
    if (message.method) this.notification(message.method, message.params ?? {});
  }
  private async serverRequest(message: Message): Promise<void> {
    const params = message.params ?? {};
    if (message.method === "currentTime/read") {
      this.send({ id: message.id!, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      this.send({ id: message.id!, result: { answers: {} } });
      return;
    }
    if (["account/chatgptAuthTokens/refresh", "attestation/generate", "item/tool/call"].includes(String(message.method))) {
      this.send({ id: message.id!, error: { code: -32601, message: `${message.method} is not available to open-agent Jobs` } });
      return;
    }
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
      "applyPatchApproval",
      "execCommandApproval",
    ]);
    if (!approvalMethods.has(String(message.method))) {
      this.send({ id: message.id!, error: { code: -32601, message: `Unsupported App Server request: ${message.method}` } });
      this.turns.get(String(params.threadId ?? params.conversationId ?? ""))?.push({
        type: "engine-error",
        message: `Installed Codex sent unsupported server request ${message.method}`,
      });
      return;
    }
    const threadId = String(params.threadId ?? params.conversationId ?? "");
    const action = normalizeApproval(String(message.method), String(message.id), params, this.activeMcp.get(threadId), this.workingDirectories.get(threadId));
    const handler = this.handlers.get(threadId);
    const decision = handler ? await handler(action, this.turnControllers.get(threadId)?.signal) : "deny";
    const accepted = decision === "allow";
    let result: unknown;
    if (message.method === "execCommandApproval" || message.method === "applyPatchApproval") result = { decision: accepted ? "approved" : { denied: { rejection: "Declined by the Approval Gate" } } };
    else if (message.method === "mcpServer/elicitation/request") result = { action: accepted ? "accept" : "decline", content: null, _meta: null };
    else if (message.method === "item/permissions/requestApproval") result = accepted ? { permissions: params.permissions ?? {}, scope: "turn", strictAutoReview: true } : { permissions: {}, scope: "turn", strictAutoReview: true };
    else result = { decision: accepted ? "accept" : "decline" };
    this.send({ id: message.id!, result });
  }
  private notification(method: string, params: Record<string, unknown>): void {
    const threadId = String(params.threadId ?? ""); const q = this.turns.get(threadId); if (!q) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = (params.tokenUsage as { last?: Record<string, unknown> } | undefined)?.last ?? {};
      this.usage.set(threadId, {
        inputTokens: Number(usage.inputTokens ?? 0), cachedInputTokens: Number(usage.cachedInputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0), reasoningOutputTokens: Number(usage.reasoningOutputTokens ?? 0),
      });
    }
    const item = params.item as Record<string, unknown> | undefined;
    if (method === "item/started" && item?.type === "mcpToolCall") {
      this.activeMcp.set(threadId, { server: String(item.server ?? "unknown"), tool: String(item.tool ?? "unknown"), arguments: item.arguments });
    } else if (method === "item/completed" && item?.type === "mcpToolCall") {
      this.activeMcp.delete(threadId);
    }
    for (const event of translate(method, params, this.usage.get(threadId))) q.push(event);
  }
  private failAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error); this.waiting.clear();
    for (const controller of this.turnControllers.values()) controller.abort();
    for (const queue of this.turns.values()) queue.push({ type: "engine-error", message: error.message });
  }
}

class EventQueue implements AsyncIterable<EngineEvent> {
  private values: EngineEvent[] = []; private wake: (() => void) | undefined;
  push(value: EngineEvent): void { this.values.push(value); this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    for (;;) { if (this.values.length === 0) await new Promise<void>((resolve) => { this.wake = resolve; }); yield this.values.shift()!; }
  }
}

function normalizeApproval(method: string, id: string, params: Record<string, unknown>, mcp?: { server: string; tool: string; arguments: unknown }, sessionWorkingDirectory?: string): PlannedAction {
  const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.map(String).join(" ") : "";
  const cwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd : (sessionWorkingDirectory ?? "");
  if (method.includes("fileChange") || method === "applyPatchApproval") return {
    id, source: "file-change", operation: "apply_patch", target: { service: "filesystem", resource: nonEmptyString(params.grantRoot) ?? cwd, environment: "local" }, arguments: params,
    workingDirectory: cwd, preview: String(params.reason ?? "Apply proposed file changes"), effect: "local-mutation", risk: "Changes files in the Job workspace.", grantScope: `file changes under ${nonEmptyString(params.grantRoot) ?? cwd}`,
  };
  if (method.includes("permissions")) return {
    id, source: "permission", operation: "grant_permissions", target: { service: "sandbox", resource: cwd || "unknown", environment: "unknown" }, arguments: params,
    workingDirectory: cwd, preview: String(params.reason ?? "Grant additional permissions"), effect: "unknown", risk: "Expands the action's technical capability.", grantScope: "this exact permission profile",
  };
  if (method === "mcpServer/elicitation/request") return {
    id, source: "mcp", operation: mcp?.tool ?? "unknown", target: { service: mcp?.server ?? String(params.serverName ?? "unknown"), resource: resourceFromArguments(mcp?.arguments), environment: environmentFromArguments(mcp?.arguments) },
    arguments: mcp?.arguments ?? params, preview: `${mcp?.server ?? String(params.serverName ?? "unknown")}.${mcp?.tool ?? "unknown"}`,
    effect: mcpEffect(mcp?.tool ?? "unknown"), risk: String(params.message ?? "The MCP server requested approval before a tool call."), grantScope: `${mcp?.server ?? String(params.serverName ?? "unknown")} ${mcp?.tool ?? "unknown"} on ${resourceFromArguments(mcp?.arguments)}`,
  };
  const lower = command.toLowerCase();
  const read = /^(pwd|ls|find|rg|grep|sed|head|tail|cat|git (status|diff|log|show|branch)|pnpm (test|typecheck)|npm test)\b/.test(lower);
  const network = params.networkApprovalContext != null || /\b(curl|wget|gh|git push|psql|mysql)\b/.test(lower);
  const consequential = network && /merge|deploy|production|force[- ]?push|delete|no-verify|hookspath|secret|credential|billing|purchase/.test(lower);
  return {
    id, source: "command", operation: firstCommand(command) === "unknown" ? method : firstCommand(command), target: { service: serviceFor(command), resource: String((params.networkApprovalContext as { host?: unknown } | undefined)?.host ?? cwd ?? "unknown"), environment: /prod/i.test(command) ? "production" : network ? "shared" : "local" },
    arguments: Array.isArray(params.command) ? params.command : shellArgv(command), workingDirectory: cwd, preview: command || String(params.reason ?? "Unknown command"),
    effect: consequential ? "consequential" : read && !network ? "read" : network ? "external-mutation" : command ? "local-mutation" : "unknown",
    risk: String(params.reason ?? (network ? "Uses an external network destination." : "Runs a command.")), grantScope: `command ${firstCommand(command)} on ${network ? serviceFor(command) : cwd}`,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function normalizeCodexEvent(method: string, params: Record<string, unknown>, usage?: import("../ports/engine.ts").TokenUsage): EngineEvent[] {
  if (method === "turn/started") return [{ type: "turn-started" }];
  if (method === "turn/plan/updated") return [{ type: "plan", steps: ((params.plan as { step?: string; status?: string }[]) ?? []).map((step) => ({ text: String(step.step ?? ""), completed: step.status === "completed" })) }];
  if (method === "turn/completed") {
    const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
    if (turn?.status === "failed" || turn?.status === "interrupted") return [{ type: "turn-failed", message: turn.error?.message ?? `Turn ${turn.status}` }];
    return [{ type: "turn-completed", usage }];
  }
  if (method === "error") return [{ type: "engine-error", message: String((params.error as { message?: unknown } | undefined)?.message ?? params.message ?? "Codex App Server error") }];
  if (method !== "item/started" && method !== "item/completed") return [];
  const item = params.item as Record<string, unknown> | undefined; if (!item) return [];
  return translateItem(item, method === "item/completed" ? "completed" : "in-progress");
}

const translate = normalizeCodexEvent;

function translateItem(item: Record<string, unknown>, status: ActivityStatus): EngineEvent[] {
  switch (item.type) {
    case "agentMessage": return status === "completed" ? [{ type: "message", text: String(item.text ?? "") }] : [];
    case "reasoning": return status === "completed" ? [{ type: "reasoning", text: [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])].join("\n") }] : [];
    case "commandExecution": return [{ type: "command", command: String(item.command ?? ""), status: statusOf(String(item.status ?? status)), output: String(item.aggregatedOutput ?? ""), exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined }];
    case "fileChange": return [{ type: "file-change", changes: ((item.changes as { path?: string; kind?: string }[]) ?? []).map((change) => ({ path: String(change.path ?? ""), kind: change.kind === "add" || change.kind === "delete" ? change.kind : "update" })), status: statusOf(String(item.status ?? status)) }];
    case "mcpToolCall": return [{ type: "tool-call", server: String(item.server ?? ""), tool: String(item.tool ?? ""), status: statusOf(String(item.status ?? status)), error: item.error ? JSON.stringify(item.error) : undefined, result: item.result ? JSON.stringify(item.result) : undefined }];
    case "webSearch": return status === "completed" ? [{ type: "web-search", query: String(item.query ?? "") }] : [];
    default: return [];
  }
}

function statusOf(status: string): ActivityStatus { return /fail|declin/.test(status) ? "failed" : /complete/.test(status) ? "completed" : "in-progress"; }
function firstCommand(command: string): string { return shellArgv(command)[0] ?? "unknown"; }
function shellArgv(command: string): string[] { return command.trim().split(/\s+/).filter(Boolean); }
function serviceFor(command: string): string { return /\b(gh|git)\b/.test(command) ? "github" : /\bcurl\b/.test(command) ? "http" : /\b(psql|mysql)\b/.test(command) ? "database" : "shell"; }
function mcpEffect(tool: string): PlannedAction["effect"] {
  const normalized = tool.toLowerCase();
  if (/merge|delete|remove|destroy|publish|deploy|permission|secret|billing|purchase/.test(normalized)) return "consequential";
  if (/(^|_)(create|update|save|add|post|comment|label|upload|push|set|write)(_|$)/.test(normalized)) return "external-mutation";
  if (/(sql|database|procedure|execute)/.test(normalized) && !/read[_-]?only/.test(normalized)) return "unknown";
  if (/^(read|get|list|search|find|fetch|query|view|download)_/.test(normalized)) return "read";
  return "unknown";
}
function resourceFromArguments(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "exact-action";
  const args = value as Record<string, unknown>;
  const repository = args.repository ?? args.repo;
  const owner = args.owner ?? args.organization;
  const parts = [owner, repository, args.teamId ?? args.team, args.database, args.table, args.projectId ?? args.project, args.issueId ?? args.pullNumber ?? args.number].filter((part) => typeof part === "string" || typeof part === "number");
  return parts.length > 0
    ? parts.map(String).join("/")
    : `exact-action:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}
function environmentFromArguments(value: unknown): string {
  const text = JSON.stringify(value ?? {}).toLowerCase();
  return /prod(uction)?/.test(text) ? "production" : /stag(e|ing)/.test(text) ? "staging" : "shared";
}

function configArguments(config: Record<string, Json>): string[] {
  const leaves: [string, Json][] = [];
  const visit = (prefix: string, value: Json): void => {
    if (value !== null && !Array.isArray(value) && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(prefix ? `${prefix}.${key}` : key, child);
    else leaves.push([prefix, value]);
  };
  visit("", config);
  return leaves.flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`]);
}

interface ResolvedCodex { path: string | undefined; version: string; }
async function resolveCodexBinary(explicitPath: string | undefined): Promise<ResolvedCodex> {
  if (explicitPath) return { path: explicitPath, version: await codexVersionOf(explicitPath) };
  try { return { path: "codex", version: await codexVersionOf("codex") }; }
  catch { return { path: undefined, version: await vendoredCodexVersion() }; }
}
async function codexVersionOf(binary: string): Promise<string> { const { stdout } = await promisify(execFile)(binary, ["--version"]); return stdout.trim().replace(/^codex-cli\s+/, ""); }
async function vendoredCodexVersion(): Promise<string> { const manifestPath = createRequire(import.meta.url).resolve("@openai/codex/package.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string }; if (!manifest.version) throw new Error(`Could not read a Codex version from ${manifestPath}`); return manifest.version; }
function vendoredCodexPath(): string { return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"); }

async function verifyAppServerProtocol(binary: string): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "open-agent-codex-protocol-"));
  try {
    await promisify(execFile)(binary, ["app-server", "generate-json-schema", "--out", directory, "--experimental"]);
    const serverRequests = await readFile(path.join(directory, "ServerRequest.json"), "utf8");
    const required = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
    ];
    const missing = required.filter((method) => !serverRequests.includes(method));
    if (missing.length > 0) throw new Error(`missing server request variants: ${missing.join(", ")}`);
  } catch (error) {
    throw new Error(`Installed Codex App Server protocol is incompatible with open-agent: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
