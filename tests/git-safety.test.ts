import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installGitSafetyHook } from "../src/git/safety.ts";
import { testTempDir } from "./support/test-root.ts";

const run = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const result = await run("git", args, { encoding: "utf8" });
  return result.stdout.trim();
}

async function failedGit(...args: string[]): Promise<string> {
  const failure = await git(...args).catch((error: unknown) => error);
  return `${(failure as { stdout?: string }).stdout ?? ""}${
    (failure as { stderr?: string }).stderr ?? ""
  }`;
}

describe("the checkout's pre-push guardrail", () => {
  it("judges destination refs and ancestry while allowing ordinary feature pushes", async () => {
    const root = await testTempDir("open-agent-git-safety-");
    const remote = path.join(root, "remote.git");
    const checkout = path.join(root, "checkout");
    await git("init", "--bare", remote);
    await mkdir(checkout);
    await git("-C", checkout, "init", "-b", "feature");
    await git("-C", checkout, "config", "user.email", "coworker@example.com");
    await git("-C", checkout, "config", "user.name", "Coworker");
    await git("-C", checkout, "config", "commit.gpgsign", "false");
    await writeFile(path.join(checkout, "README.md"), "first\n", "utf8");
    await git("-C", checkout, "add", "README.md");
    await git("-C", checkout, "commit", "-m", "first");
    await git("-C", checkout, "remote", "add", "origin", remote);
    await git("-C", checkout, "push", "origin", "HEAD:main");
    await installGitSafetyHook({ checkout, defaultBranch: "main" });
    await writeFile(path.join(checkout, "README.md"), "second\n", "utf8");
    await git("-C", checkout, "add", "README.md");
    await git("-C", checkout, "commit", "-m", "second");

    await expect(
      failedGit("-C", checkout, "push", "origin", "HEAD:main"),
    ).resolves.toContain("blocked: push to protected ref 'refs/heads/main'");
    expect(await git("-C", checkout, "config", "--get", "core.hooksPath")).toBe(
      ".open-agent-hooks",
    );

    await git("-C", checkout, "push", "origin", "HEAD:feature");
    await writeFile(path.join(checkout, "README.md"), "third\n", "utf8");
    await git("-C", checkout, "add", "README.md");
    await git("-C", checkout, "commit", "-m", "third");
    await git("-C", checkout, "push", "origin", "HEAD:feature");
    await git("-C", checkout, "reset", "--hard", "HEAD~1");
    await writeFile(path.join(checkout, "README.md"), "divergent\n", "utf8");
    await git("-C", checkout, "add", "README.md");
    await git("-C", checkout, "commit", "-m", "divergent");

    await expect(
      failedGit("-C", checkout, "push", "origin", "+HEAD:feature"),
    ).resolves.toContain(
      "blocked: non-fast-forward push to 'refs/heads/feature'",
    );
    await expect(
      failedGit("-C", checkout, "push", "origin", ":feature"),
    ).resolves.toContain(
      "blocked: deletion of remote ref 'refs/heads/feature'",
    );

    // The hook is accident protection, not the server-side boundary. A deliberate bypass
    // remains capable of replacing the coworker's own feature branch; build/12 accepts
    // that residual power because losing one of these branches costs a redo, not a merge.
    await git("-C", checkout, "push", "--no-verify", "origin", "+HEAD:feature");
  }, 15_000);
});
