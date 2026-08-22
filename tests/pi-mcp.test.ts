import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiEngine, type PiSessionRuntime } from "../src/engine/pi.ts";
import { createPiMcpTools } from "../src/mcp/pi-tools.ts";
import type { EngineEvent, PlannedAction } from "../src/ports/engine.ts";
import type { McpServerConfig } from "../src/ports/mcp.ts";
import { testTempDir } from "./support/test-root.ts";

class QuietSession implements PiSessionRuntime {
  readonly sessionId = "pi-mcp-session";
  readonly sessionFile = "/tenant/sessions/pi-mcp-session.jsonl";
  subscribe(): () => void {
    return () => {};
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
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

function fixtureServer(
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    name: "fixture",
    transport: "stdio",
    enabled: true,
    command: process.execPath,
    args: [
      path.resolve(import.meta.dirname, "fixtures", "mcp-stdio-server.mjs"),
    ],
    env: {},
    envVars: [],
    disabledTools: [],
    ...overrides,
  } as McpServerConfig;
}

describe("Pi Tenant MCP tools", () => {
  it("exposes only enabled, non-disabled configured tools and calls them through their schema", async () => {
    let tools: ToolDefinition[] = [];
    const engine = createPiEngine({
      sessionDirectory: "/tenant/sessions",
      mcpServers: [
        fixtureServer({ disabledTools: ["write_marker"] }),
        fixtureServer({ name: "disabled", enabled: false }),
      ],
      env: process.env,
      createSession: async (options) => {
        tools = options.customTools;
        return new QuietSession();
      },
    });

    await collect(
      engine.startSession({ workingDirectory: "/tenant/work" }).run("read", {
        onApproval: async () => "allow",
      }),
    );
    expect(tools.map((tool) => tool.name)).toContain("fixture__read_fixture");
    expect(tools.map((tool) => tool.name)).not.toContain(
      "fixture__write_marker",
    );
    expect(tools.some((tool) => tool.name.startsWith("disabled__"))).toBe(
      false,
    );

    const read = tools.find((tool) => tool.name === "fixture__read_fixture")!;
    expect(read.parameters).toMatchObject({ type: "object", properties: {} });
    await engine.close();
  });

  it("holds MCP mutations at the Approval Gate before execution", async () => {
    const directory = await testTempDir("pi-mcp-approval-");
    const marker = path.join(directory, "marker.txt");
    let release!: (decision: "allow" | "deny") => void;
    const decisions: PlannedAction[] = [];
    const mcp = await createPiMcpTools({
      servers: [fixtureServer()],
      env: process.env,
      authorize: async (action) => {
        decisions.push(action);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const write = mcp.tools.find(
      (tool) => tool.name === "fixture__write_marker",
    )!;
    const execution = write.execute(
      "call",
      { path: marker, contents: "written" },
      undefined,
      undefined,
      {} as never,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(decisions[0]).toMatchObject({
      source: "mcp",
      operation: "write_marker",
      target: { service: "fixture" },
    });
    release("allow");
    await expect(execution).resolves.toMatchObject({
      content: [{ type: "text", text: "marker-written" }],
    });
    expect(await readFile(marker, "utf8")).toBe("written");
    await mcp.close();
  });

  it("keeps credentials and tool calls inside each Tenant engine context and redacts audit arguments", async () => {
    async function tenant(token: string) {
      const audits: Array<{
        action: PlannedAction;
        decision: "allow" | "deny";
      }> = [];
      const mcp = await createPiMcpTools({
        servers: [fixtureServer({ envVars: ["TENANT_FIXTURE_TOKEN"] })],
        env: { TENANT_FIXTURE_TOKEN: token },
        audit: (entry) => {
          audits.push(entry);
        },
        authorize: async () => "allow",
      });
      return { mcp, tools: mcp.tools, audits };
    }

    const alpha = await tenant("alpha-secret");
    const beta = await tenant("beta-secret");
    const alphaRead = alpha.tools.find(
      (tool) => tool.name === "fixture__read_tenant_secret",
    )!;
    const betaRead = beta.tools.find(
      (tool) => tool.name === "fixture__read_tenant_secret",
    )!;
    expect(
      await alphaRead.execute(
        "a",
        { token: "argument-secret" },
        undefined,
        undefined,
        {} as never,
      ),
    ).toMatchObject({ content: [{ text: "alpha-secret" }] });
    expect(
      await betaRead.execute("b", {}, undefined, undefined, {} as never),
    ).toMatchObject({ content: [{ text: "beta-secret" }] });
    expect(alphaRead.parameters).not.toContain("alpha-secret");
    expect(alpha.audits[0]?.action.arguments).toEqual({ token: "[REDACTED]" });
    await alpha.mcp.close();
    await beta.mcp.close();
  });

  it("normalizes MCP tool failures and cancellation as Pi tool errors", async () => {
    const mcp = await createPiMcpTools({
      servers: [fixtureServer()],
      env: process.env,
      authorize: async () => "allow",
    });
    const failed = await mcp.tools
      .find((tool) => tool.name === "fixture__fail_fixture")!
      .execute("fail", {}, undefined, undefined, {} as never);
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "fixture rejected call" }],
    });

    const abort = new AbortController();
    const slow = mcp.tools
      .find((tool) => tool.name === "fixture__slow_fixture")!
      .execute("slow", {}, abort.signal, undefined, {} as never);
    abort.abort();
    await expect(slow).resolves.toMatchObject({ isError: true });
    expect(JSON.stringify((await slow).content)).toMatch(/abort|cancel/i);
    await mcp.close();
  });
});
