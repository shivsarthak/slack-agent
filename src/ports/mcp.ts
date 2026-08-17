/**
 * Connectors are MCP servers named in configuration (ADR-0005) — there is no
 * plugin interface. The wrapper probes it, generates Codex configuration, and evaluates
 * App Server's normalized pre-execution approval envelope; it does not proxy business APIs.
 */

interface McpServerPolicy {
  /** The id the server is configured under, e.g. `linear`. */
  name: string;
  /** Disabled servers remain in mcp.json but are neither probed nor exposed to Codex. */
  enabled: boolean;
  /**
   * Tools to disable **in addition** to the ones the wrapper denies on its own.
   *
   * The floor is generated rather than configured (`mcp/denylist.ts`): a self-hoster
   * cannot forget to block the irreversible ones, and cannot mistype them either. This is
   * for a judgement the project has not made — a tool a particular workspace does not want
   * its coworker calling.
   */
  disabledTools: readonly string[];
  /** Explicit trust decision for unattended Jobs; omitted connectors keep Codex defaults. */
  defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve" | undefined;
  /** Passed through to Codex when set. */
  startupTimeoutSec?: number | undefined;
  /** Passed through to Codex when set. */
  toolTimeoutSec?: number | undefined;
}

export interface McpHttpServerConfig extends McpServerPolicy {
  transport: "http";
  /** A Streamable HTTP MCP endpoint. */
  url: string;
  /** The environment variable holding the bearer token. Never the token itself. */
  bearerTokenEnvVar?: string | undefined;
  /** Non-secret fixed headers. */
  httpHeaders: Readonly<Record<string, string>>;
  /** Header name to environment-variable name. */
  envHttpHeaders: Readonly<Record<string, string>>;
}

export interface McpStdioServerConfig extends McpServerPolicy {
  transport: "stdio";
  command: string;
  args: readonly string[];
  /** Non-secret fixed environment values. */
  env: Readonly<Record<string, string>>;
  /** Environment-variable names to forward without putting their values in configuration. */
  envVars: readonly string[];
  cwd?: string | undefined;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpInventory {
  /** Every tool the server advertises, in the order it advertised them. */
  tools: string[];
}

export interface McpInventoryProber {
  probe(server: McpServerConfig): Promise<McpInventory>;
}
