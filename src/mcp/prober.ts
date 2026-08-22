import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import type {
  McpHttpServerConfig,
  McpInventory,
  McpInventoryProber,
  McpServerConfig,
  McpStdioServerConfig,
} from "../ports/mcp.ts";

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Probe configured servers through the official MCP TypeScript client.
 *
 * The SDK owns initialization, protocol versions, HTTP sessions, SSE parsing, pagination,
 * stdio process lifecycle, and shutdown. This adapter owns only the project-specific part:
 * turning a validated `mcp.json` server entry into the matching SDK transport.
 */
export function createMcpInventoryProber(
  env: NodeJS.ProcessEnv,
): McpInventoryProber {
  return {
    async probe(server: McpServerConfig): Promise<McpInventory> {
      const client = new Client(
        { name: "open-agent-preflight", version: "0.1.0" },
        // HTTP can negotiate in place. A legacy stdio probe can require a second spawned
        // process under `auto`, so keep stdio on the SDK's compatible legacy handshake.
        server.transport === "http"
          ? { versionNegotiation: { mode: "auto" } }
          : {},
      );
      const transport = transportFor(server, env);
      const timeout =
        (server.startupTimeoutSec ?? PROBE_TIMEOUT_MS / 1_000) * 1_000;

      try {
        await client.connect(transport, { timeout });
        const result = await client.listTools(undefined, {
          timeout: PROBE_TIMEOUT_MS,
        });
        return { tools: result.tools.map((tool) => tool.name) };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

export function transportFor(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv,
): Transport {
  return server.transport === "http"
    ? httpTransport(server, env)
    : stdioTransport(server, env);
}

function httpTransport(
  server: McpHttpServerConfig,
  env: NodeJS.ProcessEnv,
): StreamableHTTPClientTransport {
  const headers = new Headers(server.httpHeaders);
  const bearerTokenEnvVar = server.bearerTokenEnvVar;
  for (const [header, variable] of Object.entries(server.envHttpHeaders)) {
    headers.set(header, requiredEnv(env, variable, server.name));
  }

  return new StreamableHTTPClientTransport(new URL(server.url), {
    ...(bearerTokenEnvVar === undefined
      ? {}
      : {
          authProvider: {
            token: async () => requiredEnv(env, bearerTokenEnvVar, server.name),
          },
        }),
    ...(Object.keys(server.httpHeaders).length +
      Object.keys(server.envHttpHeaders).length ===
    0
      ? {}
      : { requestInit: { headers } }),
  });
}

function stdioTransport(
  server: McpStdioServerConfig,
  env: NodeJS.ProcessEnv,
): StdioClientTransport {
  return new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    env: {
      ...getDefaultEnvironment(),
      ...server.env,
      ...Object.fromEntries(
        server.envVars.map((variable) => [
          variable,
          requiredEnv(env, variable, server.name),
        ]),
      ),
    },
    stderr: "pipe",
  });
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  variable: string,
  server: string,
): string {
  const value = env[variable]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${variable} is not set, so connector "${server}" cannot resolve its credential`,
    );
  }
  return value;
}
