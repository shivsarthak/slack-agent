import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHostedLocalTools,
  executeHostedLocalTool,
} from "../src/hosted/local-tools.ts";
import type { PlannedAction } from "../src/ports/engine.ts";
import { testTempDir } from "./support/test-root.ts";

describe("hosted local tools", () => {
  it("exposes only the wrapper-owned contract", () => {
    const tools = createHostedLocalTools({ roots: ["/tenant/work"] });
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "list",
      "find",
      "grep",
      "write",
      "edit",
      "bash",
    ]);
  });

  it("rejects traversal and symlink escapes before filesystem access", async () => {
    const root = await testTempDir("local-tools-root-");
    const outside = await testTempDir("local-tools-outside-");
    await writeFile(path.join(outside, "secret"), "nope");
    await symlink(outside, path.join(root, "escape"));

    for (const candidate of [
      "../secret",
      path.join(root, "escape", "secret"),
    ]) {
      await expect(
        executeHostedLocalTool({ roots: [root] }, "read", { path: candidate }),
      ).rejects.toThrow(/Tenant roots/);
    }
  });

  it("holds mutations for authorization and never executes a denial", async () => {
    const root = await testTempDir("local-tools-approval-");
    const target = path.join(root, "marker.txt");
    let planned: PlannedAction | undefined;
    let release!: (decision: "allow" | "deny") => void;
    const decision = new Promise<"allow" | "deny">((resolve) => {
      release = resolve;
    });
    const pending = executeHostedLocalTool(
      {
        roots: [root],
        authorize: async (action) => {
          planned = action;
          return decision;
        },
      },
      "write",
      { path: target, content: "created" },
    );
    while (planned === undefined)
      await new Promise((resolve) => setImmediate(resolve));
    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(planned).toMatchObject({
      source: "file-change",
      effect: "local-mutation",
      target: { service: "filesystem", resource: target, environment: "local" },
    });
    release("deny");
    await expect(pending).rejects.toThrow(/denied/);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("executes approved writes inside roots and audits the decision", async () => {
    const root = await testTempDir("local-tools-write-");
    const target = path.join(root, "nested", "marker.txt");
    const audit: string[] = [];
    await executeHostedLocalTool(
      {
        roots: [root],
        authorize: async () => "allow",
        audit: (entry) => {
          audit.push(`${entry.decision}:${entry.action.operation}`);
        },
      },
      "write",
      { path: target, content: "created" },
    );
    expect(await readFile(target, "utf8")).toBe("created");
    expect(audit).toEqual(["allow:write"]);
  });

  it("classifies commands before execution and denies unknown commands without approval", async () => {
    const root = await testTempDir("local-tools-command-");
    await mkdir(path.join(root, "nested"));
    const effects: string[] = [];
    await executeHostedLocalTool(
      {
        roots: [root],
        authorize: async (action) => {
          effects.push(action.effect);
          return "allow";
        },
      },
      "bash",
      { command: "printf local > nested/result.txt" },
    );
    expect(
      await readFile(path.join(root, "nested", "result.txt"), "utf8"),
    ).toBe("local");
    expect(effects).toEqual(["local-mutation"]);

    await expect(
      executeHostedLocalTool({ roots: [root] }, "bash", {
        command: "unknown-program --do-something",
      }),
    ).rejects.toThrow(/Command policy/);
    await expect(
      executeHostedLocalTool(
        { roots: [root], authorize: async () => "allow" },
        "bash",
        { command: "target=/tmp/escape; printf bad > $target" },
      ),
    ).rejects.toThrow(/Command syntax/);
    await expect(
      executeHostedLocalTool(
        { roots: [root], authorize: async () => "allow" },
        "bash",
        { command: "printf safe; unknown-program" },
      ),
    ).rejects.toThrow(/Command policy/);
  });
});
