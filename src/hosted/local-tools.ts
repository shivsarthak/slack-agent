import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalHandler, PlannedAction } from "../ports/engine.ts";

export type HostedLocalToolName =
  | "read"
  | "list"
  | "find"
  | "grep"
  | "write"
  | "edit"
  | "bash";

export interface HostedToolAuditEntry {
  action: PlannedAction;
  decision: "allow" | "deny";
}

export interface HostedLocalToolOptions {
  /** Absolute Tenant-owned directories. The first is the command working directory. */
  roots: readonly string[];
  authorize?: ApprovalHandler | undefined;
  signal?: AbortSignal | undefined;
  audit?: ((entry: HostedToolAuditEntry) => void | Promise<void>) | undefined;
}

type Params = Record<string, unknown>;

const schemas = {
  read: Type.Object({ path: Type.String() }),
  list: Type.Object({ path: Type.Optional(Type.String()) }),
  find: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
  }),
  grep: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
  }),
  write: Type.Object({ path: Type.String(), content: Type.String() }),
  edit: Type.Object({
    path: Type.String(),
    oldText: Type.String(),
    newText: Type.String(),
  }),
  bash: Type.Object({
    command: Type.String(),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120000 })),
  }),
} as const;

const descriptions: Record<HostedLocalToolName, string> = {
  read: "Read a UTF-8 file inside the Tenant workspace.",
  list: "List a directory inside the Tenant workspace.",
  find: "Find paths by glob inside the Tenant workspace.",
  grep: "Search UTF-8 files inside the Tenant workspace.",
  write: "Create or replace a file inside an authorized Tenant root.",
  edit: "Replace one exact text occurrence in a file inside an authorized Tenant root.",
  bash: "Run a policy-checked shell command in the Tenant workspace.",
};

/** Custom Pi tools. Built-ins remain disabled; these definitions are the security seam. */
export function createHostedLocalTools(
  options: HostedLocalToolOptions,
): ToolDefinition[] {
  return (Object.keys(schemas) as HostedLocalToolName[]).map(
    (name) =>
      defineTool({
        name,
        label: name[0]!.toUpperCase() + name.slice(1),
        description: descriptions[name],
        promptSnippet: descriptions[name],
        parameters: schemas[name],
        executionMode: "sequential",
        async execute(_id, params, signal) {
          try {
            const result = await executeHostedLocalTool(
              { ...options, signal: combinedSignal(options.signal, signal) },
              name,
              params as Params,
            );
            return {
              content: [{ type: "text", text: result }],
              details: undefined,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: errorMessage(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }) as ToolDefinition,
  );
}

/** Execute through the same public contract used by the Pi definitions and contract tests. */
export async function executeHostedLocalTool(
  options: HostedLocalToolOptions,
  name: HostedLocalToolName,
  params: Params,
): Promise<string> {
  const scope = await TenantRoots.open(options.roots);
  switch (name) {
    case "read":
      return readFile(
        await scope.existing(stringParam(params, "path")),
        "utf8",
      );
    case "list": {
      const directory = await scope.existing(
        optionalString(params, "path") ?? ".",
      );
      return (await readdir(directory, { withFileTypes: true }))
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort()
        .join("\n");
    }
    case "find": {
      const root = await scope.existing(optionalString(params, "path") ?? ".");
      const matcher = globMatcher(stringParam(params, "pattern"));
      return (await walk(root, scope))
        .map((item) => path.relative(root, item))
        .filter((item) => matcher.test(posix(item)))
        .join("\n");
    }
    case "grep": {
      const root = await scope.existing(optionalString(params, "path") ?? ".");
      const expression = new RegExp(stringParam(params, "pattern"), "g");
      const files = (await stat(root)).isDirectory()
        ? await walk(root, scope)
        : [root];
      const matches: string[] = [];
      for (const file of files) {
        if (!(await stat(file)).isFile()) continue;
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        content.split("\n").forEach((line, index) => {
          expression.lastIndex = 0;
          if (expression.test(line))
            matches.push(
              `${path.relative(root, file) || path.basename(file)}:${index + 1}:${line}`,
            );
        });
      }
      return matches.join("\n");
    }
    case "write": {
      const target = await scope.writable(stringParam(params, "path"));
      const action = fileAction("write", target, options.roots[0]);
      await authorize(options, action);
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, stringParam(params, "content"));
      return `Wrote ${target}`;
    }
    case "edit": {
      const target = await scope.existing(stringParam(params, "path"));
      await scope.assertWritable(target);
      const before = await readFile(target, "utf8");
      const oldText = stringParam(params, "oldText");
      const first = before.indexOf(oldText);
      if (first < 0) throw new Error("Edit text was not found");
      if (before.indexOf(oldText, first + oldText.length) >= 0)
        throw new Error("Edit text is not unique");
      const action = fileAction("edit", target, options.roots[0]);
      await authorize(options, action);
      await atomicWrite(
        target,
        before.slice(0, first) +
          stringParam(params, "newText") +
          before.slice(first + oldText.length),
      );
      return `Edited ${target}`;
    }
    case "bash": {
      const command = stringParam(params, "command");
      await scope.validateCommand(command);
      const effect = commandEffect(command);
      const action: PlannedAction = {
        id: randomUUID(),
        source: "command",
        operation: executable(command),
        target: {
          service: effect === "external-mutation" ? "network" : "shell",
          resource: command,
          environment: effect === "external-mutation" ? "shared" : "local",
        },
        arguments: [command],
        workingDirectory: scope.cwd,
        preview: command,
        effect,
        risk: commandRisk(effect),
        grantScope: `command ${executable(command)}`,
      };
      if (effect !== "read") await authorize(options, action);
      return runCommand(
        command,
        scope.cwd,
        numberParam(params, "timeout"),
        options.signal,
      );
    }
  }
}

class TenantRoots {
  readonly roots: readonly string[];
  readonly cwd: string;
  private constructor(roots: readonly string[], cwd: string) {
    this.roots = roots;
    this.cwd = cwd;
  }
  static async open(input: readonly string[]): Promise<TenantRoots> {
    if (input.length === 0)
      throw new Error("At least one Tenant root is required");
    const roots: string[] = [];
    for (const item of input) {
      if (!path.isAbsolute(item))
        throw new Error("Tenant roots must be absolute");
      const canonical = await realpath(item);
      const metadata = await lstat(item);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw rootError();
      roots.push(canonical);
    }
    return new TenantRoots(roots, roots[0]!);
  }
  private candidate(value: string): string {
    if (value.trim() === "") throw rootError();
    const candidate = path.resolve(this.cwd, value);
    if (!this.roots.some((root) => within(root, candidate))) throw rootError();
    return candidate;
  }
  async existing(value: string): Promise<string> {
    const candidate = this.candidate(value);
    const canonical = await realpath(candidate);
    if (!this.roots.some((root) => within(root, canonical))) throw rootError();
    return canonical;
  }
  async writable(value: string): Promise<string> {
    const candidate = this.candidate(value);
    let ancestor = candidate;
    for (;;) {
      try {
        const canonical = await realpath(ancestor);
        if (!this.roots.some((root) => within(root, canonical)))
          throw rootError();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw rootError();
        ancestor = parent;
      }
    }
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) throw rootError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return candidate;
  }
  async assertWritable(value: string): Promise<void> {
    await this.writable(value);
    await access(value);
  }
  async validateCommand(command: string): Promise<void> {
    if (/\$|`|\n|\r|(^|\s)~(?:\/|\s|$)/.test(command))
      throw new Error("Command syntax cannot be proven inside Tenant roots");
    const segments = command.split(/(?:&&|\|\||[;|])/);
    for (const segment of segments) {
      const program = segment.trim().match(/^([A-Za-z0-9_.+-]+)/)?.[1];
      if (program === undefined || !COMMANDS.has(program))
        throw new Error(
          `Command policy does not allow executable: ${program ?? "unknown"}`,
        );
    }
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const raw of tokens) {
      const token = raw.replace(/^['"]|['"]$/g, "").replace(/^[<>]+/, "");
      if (token === "" || /^[;&|]+$/.test(token)) continue;
      if (
        token.startsWith("/") ||
        token === ".." ||
        token.startsWith("../") ||
        token.includes("/") ||
        (await exists(path.resolve(this.cwd, token)))
      ) {
        const candidate = this.candidate(token);
        try {
          await this.existing(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            await this.writable(candidate);
          else throw error;
        }
      }
    }
  }
}

const COMMANDS = new Set([
  "cat",
  "cd",
  "cp",
  "curl",
  "find",
  "gh",
  "git",
  "grep",
  "head",
  "ls",
  "mkdir",
  "mv",
  "npm",
  "pnpm",
  "printf",
  "pwd",
  "rg",
  "rm",
  "rsync",
  "scp",
  "ssh",
  "stat",
  "tail",
  "touch",
  "wc",
  "wget",
  "yarn",
]);

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function authorize(
  options: HostedLocalToolOptions,
  action: PlannedAction,
): Promise<void> {
  const decision = options.authorize
    ? await options.authorize(action, options.signal)
    : "deny";
  await options.audit?.({ action, decision });
  if (decision !== "allow")
    throw new Error(
      `Operation authorization denied by Approval Gate: ${action.operation}`,
    );
}

function fileAction(
  operation: "write" | "edit",
  target: string,
  cwd: string | undefined,
): PlannedAction {
  return {
    id: randomUUID(),
    source: "file-change",
    operation,
    target: { service: "filesystem", resource: target, environment: "local" },
    arguments: { path: target },
    workingDirectory: cwd,
    preview: `${operation} ${target}`,
    effect: "local-mutation",
    risk: "Changes a Tenant-owned file.",
    grantScope: `filesystem ${operation} ${target}`,
  };
}

function commandEffect(command: string): PlannedAction["effect"] {
  const normalized = command.toLowerCase();
  if (
    /\b(rm\s+-[^\n]*r|git\s+reset\s+--hard|git\s+clean|sudo|chmod|chown)\b/.test(
      normalized,
    )
  )
    return "consequential";
  if (
    /\b(git\s+push|curl|wget|gh\b|npm\s+publish|pnpm\s+publish|yarn\s+publish|ssh|scp|rsync)\b/.test(
      normalized,
    )
  )
    return "external-mutation";
  if (
    /[>;]|&&|\|\||\b(mkdir|touch|mv|cp|rm|git\s+(add|commit|checkout|switch|branch)|npm\s+(install|ci)|pnpm\s+install|yarn\s+install)\b/.test(
      normalized,
    )
  )
    return "local-mutation";
  if (
    /^\s*(pwd|ls|find|rg|grep|cat|head|tail|wc|stat|git\s+(status|diff|log|show|rev-parse))\b/.test(
      normalized,
    )
  )
    return "read";
  return "unknown";
}

function executable(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "unknown";
}
function commandRisk(effect: PlannedAction["effect"]): string {
  if (effect === "external-mutation")
    return "May change a shared external system.";
  if (effect === "consequential")
    return "May remove or broadly alter local data.";
  if (effect === "unknown") return "Command effects could not be proven.";
  return effect === "read"
    ? "Reads Tenant-local state."
    : "Changes Tenant-local state.";
}

async function runCommand(
  command: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => {
      if (chunks.reduce((sum, item) => sum + item.length, 0) < 1_000_000)
        chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const timer =
      timeout === undefined ? undefined : setTimeout(abort, timeout);
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8");
      if (signal?.aborted)
        reject(new DOMException("The operation was aborted", "AbortError"));
      else if (code !== 0)
        reject(new Error(`Command exited ${code}: ${output}`));
      else resolve(output);
    });
  });
}

async function walk(root: string, scope: TenantRoots): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await scope.existing(item);
        continue;
      }
      result.push(item);
      if (entry.isDirectory()) await visit(item);
    }
  };
  if ((await stat(root)).isDirectory()) await visit(root);
  else result.push(root);
  return result;
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`);
}
function posix(value: string): string {
  return value.split(path.sep).join("/");
}
function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
function rootError(): Error {
  return new Error("Path is outside authorized Tenant roots");
}
function stringParam(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}
function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}
function numberParam(params: Params, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function combinedSignal(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  return first && second ? AbortSignal.any([first, second]) : (first ?? second);
}
