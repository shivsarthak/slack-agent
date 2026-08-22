import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/ports/engine.ts";
import { createPiEngine, type PiSessionRuntime } from "../src/engine/pi.ts";
import { normalizePiEvent } from "../src/engine/pi.ts";
import { normalizeCodexEvent } from "../src/engine/codex.ts";

class ScriptedPiSession implements PiSessionRuntime {
  readonly sessionId = "pi-session-1";
  readonly sessionFile = "/tenant/sessions/pi-session-1.jsonl";
  aborted = false;
  failure: Error | undefined;
  private listener: ((event: unknown) => void) | undefined;

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    if (this.failure) throw this.failure;
    this.listener?.({ type: "agent_start" });
    this.listener?.({ type: "turn_start" });
    this.listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking state" },
          { type: "text", text: "Done." },
        ],
        usage: { input: 12, output: 4, cacheRead: 3 },
        stopReason: "stop",
      },
    });
    this.listener?.({
      type: "turn_end",
      message: { role: "assistant" },
      toolResults: [],
    });
    this.listener?.({
      type: "agent_end",
      messages: [
        { role: "assistant", usage: { input: 12, output: 4, cacheRead: 3 } },
      ],
      willRetry: false,
    });
    this.listener?.({ type: "agent_settled" });
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
  async waitForIdle(): Promise<void> {}
  dispose(): void {}
}

async function collect(
  stream: AsyncIterable<EngineEvent>,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Engine parity", () => {
  it("keeps Codex and Pi message, write, and error fixture semantics compatible", () => {
    expect(
      normalizeCodexEvent("item/completed", {
        item: { type: "agentMessage", text: "Done." },
      }),
    ).toEqual(
      normalizePiEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
        },
      }),
    );
    expect(
      normalizeCodexEvent("turn/completed", {
        turn: { status: "failed", error: { message: "provider failed" } },
      }),
    ).toEqual(
      normalizePiEvent({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "provider failed",
        },
      }),
    );

    const codexWrite = normalizeCodexEvent("item/completed", {
      item: {
        type: "mcpToolCall",
        server: "github",
        tool: "create_issue",
        status: "completed",
        result: { id: 13 },
      },
    });
    const piWrite = normalizePiEvent({
      type: "tool_execution_end",
      toolName: "create_issue",
      result: { content: [{ type: "text", text: "13" }] },
      isError: false,
    });
    expect(codexWrite[0]).toMatchObject({
      type: "tool-call",
      tool: "create_issue",
      status: "completed",
      error: undefined,
    });
    expect(piWrite[0]).toMatchObject({
      type: "tool-call",
      tool: "create_issue",
      status: "completed",
      error: undefined,
      result: "13",
    });
  });

  it("normalizes a Pi turn into the repository Engine vocabulary", async () => {
    const opened: Array<{ locator: string | undefined; cwd: string }> = [];
    const engine = createPiEngine({
      sessionDirectory: "/tenant/sessions",
      createSession: async ({ locator, workingDirectory }) => {
        opened.push({ locator, cwd: workingDirectory });
        return new ScriptedPiSession();
      },
    });

    const first = engine.startSession({ workingDirectory: "/tenant/work" });
    expect(await collect(first.run("do it"))).toEqual([
      {
        type: "session-started",
        sessionId: "pi-session-1",
        locator: "/tenant/sessions/pi-session-1.jsonl",
        engine: "pi",
      },
      { type: "turn-started" },
      { type: "reasoning", text: "Checking state" },
      { type: "message", text: "Done." },
      {
        type: "turn-completed",
        usage: {
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
      },
    ]);
    expect(first.id).toBe("pi-session-1");
    expect(first.locator).toBe("/tenant/sessions/pi-session-1.jsonl");

    await collect(
      engine
        .resumeSession(
          "pi-session-1",
          { workingDirectory: "/tenant/work" },
          "/tenant/sessions/pi-session-1.jsonl",
        )
        .run("again"),
    );
    expect(opened).toEqual([
      { locator: undefined, cwd: "/tenant/work" },
      { locator: "/tenant/sessions/pi-session-1.jsonl", cwd: "/tenant/work" },
    ]);
  });

  it("aborts the Pi session and rejects iteration when the wrapper cancels", async () => {
    const runtime = new ScriptedPiSession();
    const engine = createPiEngine({
      sessionDirectory: "/tenant/sessions",
      createSession: async () => runtime,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        engine
          .startSession({ workingDirectory: "/tenant/work" })
          .run("stop", { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.aborted).toBe(true);
  });

  it("normalizes runtime failures and confines resumed locators to the Tenant Session directory", async () => {
    const runtime = new ScriptedPiSession();
    runtime.failure = new Error("provider unavailable");
    const engine = createPiEngine({
      sessionDirectory: "/tenant/sessions",
      createSession: async () => runtime,
    });
    await expect(
      collect(
        engine.startSession({ workingDirectory: "/tenant/work" }).run("fail"),
      ),
    ).resolves.toEqual([
      {
        type: "session-started",
        sessionId: "pi-session-1",
        locator: "/tenant/sessions/pi-session-1.jsonl",
        engine: "pi",
      },
      { type: "engine-error", message: "provider unavailable" },
    ]);

    const production = createPiEngine({
      sessionDirectory: "/tenant/alpha/sessions",
    });
    await expect(
      collect(
        production
          .resumeSession(
            "pi-beta",
            { workingDirectory: "/tenant/alpha/work" },
            "/tenant/beta/sessions/pi-beta.jsonl",
          )
          .run("resume"),
      ),
    ).rejects.toThrow(/outside this Tenant/);
  });
});
