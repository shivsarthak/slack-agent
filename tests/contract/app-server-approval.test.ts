import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexEngine } from "../../src/engine/codex.ts";
import type { Engine, EngineEvent, PlannedAction } from "../../src/ports/engine.ts";
import type { McpStdioServerConfig } from "../../src/ports/mcp.ts";

let engine: Engine;
let workspace: string;

beforeAll(async () => {
  engine = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low", approvalMode: "coworker" });
  workspace = await mkdtemp(path.join(os.tmpdir(), "open-agent-app-server-contract-"));
});
afterAll(async () => { await engine.close(); await rm(workspace, { recursive: true, force: true }); });

describe("App Server approval contract", () => {
  it("holds a harmless marker mutation until one exact allow", async () => {
    const marker = path.join(workspace, "allowed-marker.txt");
    let planned: PlannedAction | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const events: EngineEvent[] = [];
    const run = (async () => {
      for await (const event of engine.startSession({ workingDirectory: workspace }).run(
        "Using the file-editing tool, create allowed-marker.txt containing ALLOWED, then reply DONE.",
        { onApproval: async (action) => { planned = action; await held; return "allow"; } },
      )) events.push(event);
    })();
    while (planned === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(planned.effect).toBe("local-mutation");
    expect(planned.target).toEqual({
      service: "filesystem",
      resource: workspace,
      environment: "local",
    });
    expect(planned.workingDirectory).toBe(workspace);
    expect(planned.grantScope).toBe(`file changes under ${workspace}`);
    release(); await run;
    expect(await readFile(marker, "utf8")).toContain("ALLOWED");
    expect(events.some((event) => event.type === "turn-completed")).toBe(true);
  });

  it("leaves a denied marker absent while the Turn can report the denial", async () => {
    const marker = path.join(workspace, "denied-marker.txt");
    const messages: string[] = [];
    for await (const event of engine.startSession({ workingDirectory: workspace }).run(
      "Using the file-editing tool, try to create denied-marker.txt containing DENIED. If permission is declined, reply DECLINED.",
      { onApproval: async () => "deny" },
    )) if (event.type === "message") messages.push(event.text);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(messages.join("\n")).toMatch(/DECLINED|denied|declined/i);
  });

  it("auto-resolves a proven MCP read and holds a mutation before the server executes it", async () => {
    const fixture: McpStdioServerConfig = {
      name: "fixture", transport: "stdio", command: process.execPath,
      args: [path.resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs")],
      env: {}, envVars: [], enabled: true, disabledTools: [],
    };
    const mcpEngine = await createCodexEngine({
      model: "gpt-5.6-sol", reasoningEffort: "low", approvalMode: "external-writes", mcpServers: [fixture],
    });
    const marker = path.join(workspace, "mcp-marker.txt");
    let heldMutation: PlannedAction | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = (async () => {
      for await (const _event of mcpEngine.startSession({ workingDirectory: workspace }).run(
        `Call fixture.read_fixture once. Then call fixture.write_marker with path ${JSON.stringify(marker)} and contents MCP. Reply DONE.`,
        { onApproval: async (action) => {
          if (action.effect === "read") return "allow";
          heldMutation = action; await held; return "allow";
        } },
      )) { /* consume */ }
    })();
    while (heldMutation === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(heldMutation.source).toBe("mcp");
    expect(heldMutation.operation).toBe("write_marker");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    release(); await run;
    expect(await readFile(marker, "utf8")).toBe("MCP");
    await mcpEngine.close();
  });
});
