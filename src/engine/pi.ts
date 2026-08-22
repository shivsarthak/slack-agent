import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  type ToolDefinition,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type {
  Engine,
  EngineEvent,
  EngineSession,
  SandboxPosture,
  SessionOptions,
  TokenUsage,
} from "../ports/engine.ts";
import {
  createHostedLocalTools,
  type HostedToolAuditEntry,
} from "../hosted/local-tools.ts";

/** The deliberately small surface PiEngine consumes, also used by parity fixtures. */
export interface PiSessionRuntime {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export interface PiEngineOptions {
  /** Tenant-mounted directory in which Pi owns its append-only Session files. */
  sessionDirectory: string;
  /** Pi's global configuration/auth directory for this Tenant worker. */
  agentDirectory?: string;
  /** Durable decision sink supplied by hosted composition. */
  auditToolDecision?:
    | ((entry: HostedToolAuditEntry) => void | Promise<void>)
    | undefined;
  createSession?: (options: {
    workingDirectory: string;
    sessionDirectory: string;
    locator?: string;
    oneOff: boolean;
    customTools: ToolDefinition[];
  }) => Promise<PiSessionRuntime>;
}

const POSTURE: SandboxPosture = {
  mode: "external-tenant-isolation",
  networkEnabled: true,
  execPolicy: "no built-in tools",
};

export function createPiEngine(options: PiEngineOptions): Engine {
  const active = new Map<PiSessionRuntime, EventQueue>();
  let closed = false;
  const instantiate =
    options.createSession ??
    (async ({
      workingDirectory,
      sessionDirectory,
      locator,
      oneOff,
      customTools,
    }) => {
      const manager = oneOff
        ? SessionManager.inMemory(workingDirectory)
        : locator
          ? SessionManager.open(
              locatorWithin(sessionDirectory, locator),
              sessionDirectory,
              workingDirectory,
            )
          : SessionManager.create(workingDirectory, sessionDirectory);
      const result = await createAgentSession({
        cwd: workingDirectory,
        ...(options.agentDirectory ? { agentDir: options.agentDirectory } : {}),
        sessionManager: manager,
        noTools: "all",
        tools: customTools.map((tool) => tool.name),
        customTools,
      });
      return result.session;
    });

  const makeSession = (
    sessionOptions: SessionOptions,
    existingId?: string,
    locator?: string,
    oneOff = false,
  ): EngineSession => {
    let id: string | null = existingId ?? null;
    let opaqueLocator: string | null = locator ?? null;
    return {
      get id() {
        return id;
      },
      get locator() {
        return opaqueLocator;
      },
      run(prompt, runOptions = {}) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (closed) throw new Error("PiEngine is closed");
          const customTools = createHostedLocalTools({
            roots: [
              sessionOptions.workingDirectory,
              ...(sessionOptions.writableDirectories ?? []),
            ],
            authorize: runOptions.onApproval,
            signal: runOptions.signal,
            audit: options.auditToolDecision,
          });
          const runtime = await instantiate({
            workingDirectory: sessionOptions.workingDirectory,
            sessionDirectory: options.sessionDirectory,
            ...(locator ? { locator } : {}),
            oneOff,
            customTools,
          });
          id = runtime.sessionId;
          opaqueLocator = oneOff
            ? null
            : (runtime.sessionFile ?? locator ?? null);
          if (!oneOff && opaqueLocator === null) {
            runtime.dispose();
            active.delete(runtime);
            throw new Error("Pi created a resumable Session without a locator");
          }
          yield {
            type: "session-started",
            sessionId: id,
            ...(opaqueLocator === null ? {} : { locator: opaqueLocator }),
            engine: "pi",
          };

          const queue = new EventQueue();
          active.set(runtime, queue);
          let failed = false;
          const unsubscribe = runtime.subscribe((event) => {
            for (const normalized of normalizePiEvent(event)) {
              if (
                normalized.type === "turn-failed" ||
                normalized.type === "engine-error"
              )
                failed = true;
              if (failed && normalized.type === "turn-completed") continue;
              queue.push(normalized);
            }
          });
          const abort = (): void => {
            void runtime.abort().finally(() => queue.finish(abortError()));
          };
          if (runOptions.signal?.aborted) abort();
          else
            runOptions.signal?.addEventListener("abort", abort, { once: true });

          try {
            if (runOptions.signal?.aborted) throw abortError();
            const images = await Promise.all(
              (runOptions.imagePaths ?? []).map(loadImage),
            );
            const prompting = runtime
              .prompt(prompt, images.length === 0 ? undefined : { images })
              .then(() => runtime.waitForIdle())
              .then(() => queue.finish())
              .catch((error: unknown) => {
                if (runOptions.signal?.aborted) queue.finish(abortError());
                else {
                  queue.push({
                    type: "engine-error",
                    message: asError(error).message,
                  });
                  queue.finish();
                }
              });
            for await (const event of queue) yield event;
            await prompting;
            if (runOptions.signal?.aborted) throw abortError();
          } finally {
            runOptions.signal?.removeEventListener("abort", abort);
            unsubscribe();
            runtime.dispose();
            active.delete(runtime);
          }
        })();
      },
    };
  };

  return {
    version: async () => VERSION,
    sandbox: POSTURE,
    startSession: (sessionOptions) => makeSession(sessionOptions),
    startOneOffSession: (sessionOptions) =>
      makeSession(sessionOptions, undefined, undefined, true),
    resumeSession: (sessionId, sessionOptions, locator) => {
      if (!locator)
        throw new Error("Pi Session resume requires its opaque locator");
      return makeSession(sessionOptions, sessionId, locator);
    },
    async close() {
      closed = true;
      await Promise.all(
        [...active].map(async ([session, queue]) => {
          await session.abort().catch(() => {});
          queue.finish(abortError());
        }),
      );
      for (const session of active.keys()) session.dispose();
      active.clear();
    },
  };
}

export function normalizePiEvent(value: unknown): EngineEvent[] {
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "turn_start":
      return [{ type: "turn-started" }];
    case "message_end":
      return normalizeMessage(event.message);
    case "tool_execution_start":
      return [
        {
          type: "tool-call",
          server: "pi",
          tool: String(event.toolName ?? ""),
          status: "in-progress",
          error: undefined,
          result: undefined,
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool-call",
          server: "pi",
          tool: String(event.toolName ?? ""),
          status: event.isError ? "failed" : "completed",
          error: event.isError ? textOf(event.result) : undefined,
          result: event.isError ? undefined : textOf(event.result),
        },
      ];
    case "agent_end":
      return event.willRetry
        ? []
        : [
            {
              type: "turn-completed",
              usage: usageFromMessages(event.messages),
            },
          ];
    default:
      return [];
  }
}

function normalizeMessage(value: unknown): EngineEvent[] {
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return [];
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return [
      {
        type: "turn-failed",
        message: String(message.errorMessage ?? `Turn ${message.stopReason}`),
      },
    ];
  }
  const events: EngineEvent[] = [];
  for (const block of Array.isArray(message.content)
    ? (message.content as Record<string, unknown>[])
    : []) {
    if (block.type === "thinking" && block.thinking)
      events.push({ type: "reasoning", text: String(block.thinking) });
    if (block.type === "text" && block.text)
      events.push({ type: "message", text: String(block.text) });
  }
  return events;
}

function usageFromMessages(value: unknown): TokenUsage | undefined {
  if (!Array.isArray(value)) return undefined;
  let found = false;
  const total: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const message of value as Record<string, unknown>[]) {
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    found = true;
    total.inputTokens += number(usage.input);
    total.cachedInputTokens += number(usage.cacheRead);
    total.outputTokens += number(usage.output);
    total.reasoningOutputTokens += number(usage.reasoning);
  }
  return found ? total : undefined;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  const text = result.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return text || JSON.stringify(value);
}

async function loadImage(
  filePath: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType =
    extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : "image/jpeg";
  return {
    type: "image",
    data: (await readFile(filePath)).toString("base64"),
    mimeType,
  };
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function locatorWithin(sessionDirectory: string, locator: string): string {
  const root = path.resolve(sessionDirectory);
  const candidate = path.resolve(locator);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      "Pi Session locator is outside this Tenant's Session directory",
    );
  }
  return candidate;
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

class EventQueue implements AsyncIterable<EngineEvent> {
  private values: EngineEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private error: Error | undefined;
  push(event: EngineEvent): void {
    if (!this.done) {
      this.values.push(event);
      this.wake?.();
      this.wake = undefined;
    }
  }
  finish(error?: Error): void {
    if (!this.done) {
      this.done = true;
      this.error = error;
      this.wake?.();
      this.wake = undefined;
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    while (!this.done || this.values.length > 0) {
      if (this.values.length === 0)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      const event = this.values.shift();
      if (event) yield event;
    }
    if (this.error) throw this.error;
  }
}
