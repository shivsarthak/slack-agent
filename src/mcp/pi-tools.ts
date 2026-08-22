import { randomUUID } from "node:crypto";
import {
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { disabledToolsFor } from "./denylist.ts";
import { transportFor } from "./prober.ts";
import type { McpServerConfig } from "../ports/mcp.ts";
import type { ApprovalHandler, PlannedAction } from "../ports/engine.ts";
import type { HostedToolAuditEntry } from "../hosted/local-tools.ts";

export interface PiMcpToolOptions {
  servers: readonly McpServerConfig[];
  env: NodeJS.ProcessEnv;
  authorize?: ApprovalHandler | undefined;
  signal?: AbortSignal | undefined;
  audit?: ((entry: HostedToolAuditEntry) => void | Promise<void>) | undefined;
}

export interface PiMcpToolSet {
  tools: ToolDefinition[];
  close(): Promise<void>;
}

/** Connect this Tenant's configured servers and adapt their live inventory to Pi tools. */
export async function createPiMcpTools(
  options: PiMcpToolOptions,
): Promise<PiMcpToolSet> {
  const clients: Client[] = [];
  const tools: ToolDefinition[] = [];
  const names = new Set<string>();
  try {
    for (const server of options.servers.filter(
      (candidate) => candidate.enabled,
    )) {
      const client = new Client(
        { name: "open-agent-pi", version: "0.1.0" },
        server.transport === "http"
          ? { versionNegotiation: { mode: "auto" } }
          : {},
      );
      await client.connect(transportFor(server, options.env), {
        timeout: (server.startupTimeoutSec ?? 30) * 1_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      clients.push(client);
      const inventory = await client.listTools(
        undefined,
        options.signal ? { signal: options.signal } : {},
      );
      const disabled = new Set(disabledToolsFor(server));
      for (const tool of inventory.tools) {
        if (disabled.has(tool.name)) continue;
        const name = scopedName(server.name, tool.name);
        if (names.has(name))
          throw new Error(`MCP tool name collision after Pi scoping: ${name}`);
        names.add(name);
        tools.push(adaptTool(server, client, tool, options));
      }
    }
    return { tools, close: () => closeAll(clients) };
  } catch (error) {
    await closeAll(clients);
    throw error;
  }
}

function adaptTool(
  server: McpServerConfig,
  client: Client,
  tool: Tool,
  options: PiMcpToolOptions,
): ToolDefinition {
  const name = scopedName(server.name, tool.name);
  const description =
    tool.description?.trim() || `${tool.name} on ${server.name}`;
  return defineTool({
    name,
    label: `${server.name}: ${tool.title ?? tool.name}`,
    description,
    promptSnippet: description,
    // MCP supplies JSON Schema; Type.Unsafe preserves it for Pi's provider validation.
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    executionMode: "sequential",
    async execute(callId, params, signal) {
      const combined = combineSignals(options.signal, signal);
      const action = mcpAction(callId, server.name, tool.name, params);
      try {
        const decision = options.authorize
          ? await options.authorize(action, combined)
          : "deny";
        await options.audit?.({ action, decision });
        if (decision !== "allow")
          throw new Error(
            `Operation authorization denied by Approval Gate: ${tool.name}`,
          );
        if (combined?.aborted) throw abortError();
        const result = await client.callTool(
          { name: tool.name, arguments: params },
          {
            ...(combined ? { signal: combined } : {}),
            timeout: (server.toolTimeoutSec ?? 60) * 1_000,
            toolDefinition: tool,
          },
        );
        return {
          content: normalizeContent(result.content, result.structuredContent),
          details: undefined,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: errorMessage(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  }) as ToolDefinition;
}

function mcpAction(
  id: string,
  server: string,
  tool: string,
  args: unknown,
): PlannedAction {
  const effect = effectFor(tool);
  const resource = resourceFrom(args);
  return {
    id: id || randomUUID(),
    source: "mcp",
    operation: tool,
    target: { service: server, resource, environment: environmentFrom(args) },
    arguments: redact(args),
    preview: `${server}.${tool} on ${resource}`,
    effect,
    risk:
      effect === "read"
        ? "Reads data from a configured Tenant service."
        : "May change data in a configured Tenant service.",
    grantScope: `${server} ${tool} on ${resource}`,
  };
}

function effectFor(tool: string): PlannedAction["effect"] {
  const value = tool.toLowerCase();
  if (
    /merge|delete|remove|destroy|publish|deploy|permission|secret|billing|purchase/.test(
      value,
    )
  )
    return "consequential";
  if (
    /(^|_)(create|update|save|add|post|comment|label|upload|push|set|write)(_|$)/.test(
      value,
    )
  )
    return "external-mutation";
  if (/^(read|get|list|search|find|fetch|query|view|download)(_|$)/.test(value))
    return "read";
  return "unknown";
}

function resourceFrom(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unspecified";
  const args = value as Record<string, unknown>;
  for (const key of [
    "url",
    "repository",
    "repo",
    "project",
    "issue",
    "id",
    "path",
    "resource",
  ]) {
    const candidate = args[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.slice(0, 240);
  }
  return "unspecified";
}

function environmentFrom(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    /prod/i.test(String((value as Record<string, unknown>).environment ?? ""))
    ? "production"
    : "shared";
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null)
    return typeof value === "string" ? redactText(value) : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(authorization|bearer|token|password|secret|credential|api.?key)/i.test(
        key,
      )
        ? "[REDACTED]"
        : redact(item),
    ]),
  );
}

function redactText(value: string): string {
  return value
    .replace(
      /(bearer|token|password|secret|credential|api.?key)([ =:]+)[^\s]+/gi,
      "$1$2[REDACTED]",
    )
    .slice(0, 800);
}

function normalizeContent(
  content: unknown,
  structured: unknown,
): Array<TextContent | ImageContent> {
  const blocks = Array.isArray(content) ? content : [];
  const normalized: Array<TextContent | ImageContent> = blocks.map(
    (block): TextContent | ImageContent => {
      const item = block as Record<string, unknown>;
      if (item.type === "text")
        return { type: "text", text: String(item.text ?? "") };
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      )
        return { type: "image", data: item.data, mimeType: item.mimeType };
      return { type: "text", text: JSON.stringify(item) };
    },
  );
  if (normalized.length === 0 && structured !== undefined)
    normalized.push({ type: "text", text: JSON.stringify(structured) });
  return normalized.length === 0
    ? [{ type: "text", text: "MCP tool completed without content." }]
    : normalized;
}

function scopedName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function combineSignals(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal | undefined {
  const signals = [first, second].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return signals.length === 0
    ? undefined
    : signals.length === 1
      ? signals[0]
      : AbortSignal.any(signals);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function closeAll(clients: Client[]): Promise<void> {
  await Promise.all(
    clients.map((client) => client.close().catch(() => undefined)),
  );
}
