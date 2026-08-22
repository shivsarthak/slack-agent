import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release qualification CI", () => {
  it("cannot produce qualification evidence before repository verification and an immutable image", async () => {
    const workflow = await readFile(
      ".github/workflows/qualify-release.yml",
      "utf8",
    );
    const verify = workflow.indexOf("./scripts/verify");
    const build = workflow.indexOf("docker build");
    const qualify = workflow.indexOf("scripts/qualify-release.ts");

    expect(verify).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(verify);
    expect(qualify).toBeGreaterThan(build);
    expect(workflow).toContain("github.sha");
    expect(workflow).toContain("--iidfile");
    expect(workflow).toContain("qualification-manifest");
  });
});
