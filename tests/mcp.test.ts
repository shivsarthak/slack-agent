import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpInventoryProber } from "../src/mcp/prober.ts";
import type { McpServerConfig } from "../src/ports/mcp.ts";

describe("the official MCP client adapter", () => {
  it("starts a stdio server, completes the handshake, and reads its tools", async () => {
    const server: McpServerConfig = {
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
    };

    const inventory = await createMcpInventoryProber(process.env).probe(server);

    expect(inventory.tools).toEqual([
      "read_fixture",
      "write_marker",
      "read_tenant_secret",
      "fail_fixture",
      "slow_fixture",
    ]);
  });
});
