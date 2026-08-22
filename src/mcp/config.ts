import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServerConfig } from "../ports/mcp.ts";

export const DEFAULT_MCP_CONFIG_FILENAME = "mcp.json";

const policyShape = {
  disabledTools: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  startupTimeoutSec: z.number().positive().optional(),
  toolTimeoutSec: z.number().positive().optional(),
};

const httpServerSchema = z
  .object({
    type: z.literal("streamable-http"),
    url: z.string().url(),
    bearerTokenEnvVar: z.string().min(1).optional(),
    httpHeaders: z.record(z.string(), z.string()).default({}),
    envHttpHeaders: z.record(z.string(), z.string().min(1)).default({}),
    ...policyShape,
  })
  .strict()
  .superRefine((server, context) => {
    for (const header of [
      ...Object.keys(server.httpHeaders),
      ...Object.keys(server.envHttpHeaders),
    ]) {
      if (RESERVED_HTTP_HEADERS.has(header.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path:
            server.httpHeaders[header] === undefined
              ? ["envHttpHeaders", header]
              : ["httpHeaders", header],
          message:
            `${header} is owned by the MCP transport. Use bearerTokenEnvVar for ` +
            "Authorization; session and protocol headers are managed by the SDK.",
        });
      }
    }
  });

const stdioServerSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    envVars: z.array(z.string().min(1)).default([]),
    cwd: z.string().min(1).optional(),
    ...policyShape,
  })
  .strict();

const RESERVED_HTTP_HEADERS = new Set([
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
]);

export const mcpFileSchema = z
  .object({
    $schema: z.string().optional(),
    mcpServers: z.record(
      z.string().min(1),
      z.discriminatedUnion("type", [httpServerSchema, stdioServerSchema]),
    ),
  })
  .strict();

export interface LoadedMcpConfig {
  source: string;
  servers: McpServerConfig[];
}

/**
 * Load every MCP server from the one project-owned `mcp.json`.
 *
 * MCP standardizes transports and messages, not host configuration files. This module is
 * therefore the seam between our small, familiar JSON shape and both clients that consume
 * it: the official MCP SDK used by preflight and Codex's generated `config.toml` values.
 */
export async function loadMcpConfig(options: {
  filePath: string;
  required: boolean;
}): Promise<LoadedMcpConfig> {
  const filePath = path.resolve(options.filePath);
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (!options.required && isMissing(error)) {
      return { source: `no ${DEFAULT_MCP_CONFIG_FILENAME}`, servers: [] };
    }
    throw new Error(`MCP configuration ${filePath} cannot be read: ${reasonFor(error)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${reasonFor(error)}`);
  }

  const parsed = mcpFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${filePath} is not valid MCP configuration:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}\n\nSee mcp.example.json for a worked example.`,
    );
  }

  const from = (given: string): string => path.resolve(path.dirname(filePath), given);
  const servers = Object.entries(parsed.data.mcpServers).map(
    ([name, server]): McpServerConfig => {
      const policy = {
        name,
        enabled: server.enabled,
        disabledTools: server.disabledTools,
        startupTimeoutSec: server.startupTimeoutSec,
        toolTimeoutSec: server.toolTimeoutSec,
      };
      if ("url" in server) {
        return {
          ...policy,
          transport: "http",
          url: server.url,
          bearerTokenEnvVar: server.bearerTokenEnvVar,
          httpHeaders: server.httpHeaders,
          envHttpHeaders: server.envHttpHeaders,
        };
      }
      return {
        ...policy,
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
        envVars: server.envVars,
        cwd: server.cwd === undefined ? undefined : from(server.cwd),
      };
    },
  );

  return { source: filePath, servers };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
