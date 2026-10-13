import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkSandboxStorage } from "../src/preflight/storage.ts";
import { testTempDir } from "./support/test-root.ts";

/**
 * The startup storage report.
 *
 * It is a **report**, never a refusal: a self-hoster who put the state directory on a small
 * volume is entitled to run that way, and no check can know how large a Job's next install
 * will be. Two properties matter. A directory that exists is measured, and one that does not
 * yet exist is measured at its nearest existing ancestor rather than failing — the sandbox's
 * own `tmp`/`cache` leaves are created lazily by the first Job, so preflight runs before they
 * are there.
 */
function recordingLogger() {
  const info: string[] = [];
  const warnings: string[] = [];
  return {
    info: (message: string) => info.push(message),
    warn: (message: string) => warnings.push(message),
    infoMessages: info,
    warnings,
  };
}

describe("the startup storage report", () => {
  it("reports free space for an existing sandbox root", async () => {
    const root = await testTempDir("storage-report-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const log = recordingLogger();

    await checkSandboxStorage({ sandboxRoot: root, log });

    expect(log.warnings).toHaveLength(0);
    expect(log.infoMessages).toHaveLength(1);
    expect(log.infoMessages[0]).toContain("free");
  });

  it("measures the nearest existing ancestor when the sandbox root is not created yet", async () => {
    const root = await testTempDir("storage-ancestor-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    const log = recordingLogger();

    // `stateDir/sandbox` does not exist — exactly the preflight case, since the first Job
    // has not run. The check still produces one report rather than a spurious warning.
    await checkSandboxStorage({ sandboxRoot: path.join(stateDir, "sandbox"), log });

    expect(log.warnings).toHaveLength(0);
    expect(log.infoMessages).toHaveLength(1);
  });

  it("never stops startup: a root whose whole tree is missing still reports", async () => {
    const log = recordingLogger();

    await checkSandboxStorage({
      sandboxRoot: "/this/path/does/not/exist/open-agent-sandbox",
      log,
    });

    // The nearest existing ancestor is `/`, which is measurable, so this is a report.
    expect(log.infoMessages).toHaveLength(1);
    expect(log.warnings).toHaveLength(0);
  });
});
