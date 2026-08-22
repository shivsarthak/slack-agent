import { describe, expect, it, vi } from "vitest";
import { createCanaryAdmission } from "../src/hosted/canary-admission.ts";
import { createCanaryBootstrap } from "../src/hosted/worker.ts";
import type { JobLease } from "../src/hosted/postgres/job-queue.ts";

describe("hosted worker canary routing", () => {
  it("boots Pi only for admitted Tenants and otherwise uses Codex", async () => {
    const admission = createCanaryAdmission({
      enabled: true,
      allowlist: ["tenant-pi"],
      thresholds: { minimumJobs: 10, maximumFailureRate: 0.1 },
    });
    const pi = vi.fn().mockResolvedValue({ engineName: "pi" });
    const codex = vi.fn().mockResolvedValue({ engineName: "codex" });
    const bootstrap = createCanaryBootstrap({ admission, pi, codex });

    await expect(
      bootstrap(lease("tenant-pi", "job-pi")),
    ).resolves.toMatchObject({ engineName: "pi" });
    await expect(
      bootstrap(lease("tenant-other", "job-codex")),
    ).resolves.toMatchObject({ engineName: "codex" });
    expect(pi).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(1);
  });
});

function lease(tenantId: string, id: string): JobLease {
  return {
    tenantId,
    id,
    status: "running",
    leaseOwner: "worker",
    leaseToken: "lease",
    leaseExpiresAt: new Date(Date.now() + 10_000),
    threadKey: "C1\u00001.0",
    request: "work",
    attempt: 1,
    availableAt: new Date(),
  };
}
