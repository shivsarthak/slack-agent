import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("the repository verification seam", () => {
  it("runs every release-critical stage in order", async () => {
    const fake = await fakePnpm();

    const result = await execa("./scripts/verify", {
      cwd: repositoryRoot,
      env: {
        PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
        VERIFY_LOG: fake.log,
      },
    });

    expect(result.stdout).toContain("[verify] dependencies");
    expect(result.stdout).toContain("[verify] formatting");
    expect(result.stdout).toContain("[verify] root typecheck");
    expect(result.stdout).toContain("[verify] dashboard typecheck");
    expect(result.stdout).toContain("[verify] tests");
    expect(result.stdout).toContain("[verify] migrations");
    expect(result.stdout).toContain("[verify] tenant isolation");
    expect(result.stdout).toContain("[verify] encryption");
    expect(result.stdout).toContain("[verify] queue semantics");
    expect(result.stdout).toContain("[verify] launcher and container policy");
    expect(result.stdout).toContain("[verify] Compose validation");
    expect(result.stdout).toContain("[verify] fake-service smoke");

    expect((await readFile(fake.log, "utf8")).trim().split("\n")).toEqual([
      "install --frozen-lockfile",
      "--dir dashboard install --frozen-lockfile",
      "format:check",
      "typecheck",
      "--dir dashboard typecheck",
      "test",
      "test:migrations",
      "test:isolation",
      "test:encryption",
      "test:queue",
      "test:container-policy",
      "compose:check",
      "test:smoke",
    ]);
  });

  it("names the failing stage, exits non-zero, and stops", async () => {
    const fake = await fakePnpm("test:encryption");

    const result = await execa("./scripts/verify", {
      cwd: repositoryRoot,
      reject: false,
      env: {
        PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
        VERIFY_LOG: fake.log,
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[verify] FAILED: encryption");
    expect(await readFile(fake.log, "utf8")).not.toContain("test:queue");
  });
});

async function fakePnpm(
  failingCommand?: string,
): Promise<{ bin: string; log: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "open-agent-verify-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "pnpm");
  const log = path.join(directory, "calls.log");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$VERIFY_LOG"\n[ "$*" != "${failingCommand ?? "__never__"}" ]\n`,
  );
  await chmod(executable, 0o755);
  return { bin: directory, log };
}
