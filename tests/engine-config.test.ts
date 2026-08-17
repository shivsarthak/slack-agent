import { describe, expect, it } from "vitest";
import { engineConfig } from "../src/engine/codex.ts";
import type { McpHttpServerConfig } from "../src/ports/mcp.ts";

const github: McpHttpServerConfig = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  bearerTokenEnvVar: "GITHUB_TOKEN",
  httpHeaders: {},
  envHttpHeaders: {},
  enabled: true,
  disabledTools: [],
  startupTimeoutSec: undefined,
  toolTimeoutSec: undefined,
};

describe("the engine's external tools", () => {
  it("routes guarded approvals to the wrapper and preserves off mode explicitly", () => {
    expect(engineConfig([]).approval_policy).toBe("on-request");
    expect(engineConfig([], "off").approval_policy).toBe("never");
  });

  it("disables inherited Codex Apps while preserving explicitly configured MCP servers", () => {
    const config = engineConfig([github]);

    expect(config.features).toEqual({ apps: false });
    expect(config.mcp_servers).toMatchObject({
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        bearer_token_env_var: "GITHUB_TOKEN",
        enabled: true,
      },
    });
  });

  it("intercepts every MCP tool in guarded modes, including previously trusted servers", () => {
    const schedules: McpHttpServerConfig = {
      ...github,
      name: "schedules",
      defaultToolsApprovalMode: "approve",
    };

    const config = engineConfig([github, schedules]);

    expect(config.mcp_servers).toMatchObject({
      schedules: { default_tools_approval_mode: "prompt" },
    });
    expect((config.mcp_servers as Record<string, { default_tools_approval_mode?: string }>).github?.default_tools_approval_mode).toBe("prompt");
  });

  it("still disables Codex Apps when no MCP server is configured", () => {
    const config = engineConfig([]);

    expect(config.features).toEqual({ apps: false });
    expect(config).not.toHaveProperty("mcp_servers");
  });
});
