import { describe, expect, it } from "vitest";
import {
  createCanaryAdmission,
  type CanaryEvidence,
} from "../src/hosted/canary-admission.ts";

describe("Tenant canary admission", () => {
  it("keeps non-allowlisted and disabled Tenants on Codex", () => {
    const admission = createCanaryAdmission({
      enabled: true,
      allowlist: ["tenant-canary"],
      thresholds: { minimumJobs: 2, maximumFailureRate: 0.1 },
    });

    expect(admission.decide("tenant-other", "job-1").engine).toBe("codex");
    admission.configure({ enabled: false, allowlist: ["tenant-canary"] });
    expect(admission.decide("tenant-canary", "job-2").engine).toBe("codex");
  });

  it("does not reinterpret an existing Job decision when the canary is disabled", () => {
    const admission = createCanaryAdmission({
      enabled: true,
      allowlist: ["tenant-canary"],
      thresholds: { minimumJobs: 2, maximumFailureRate: 0.1 },
    });
    const decision = admission.decide("tenant-canary", "job-1");

    admission.configure({ enabled: false, allowlist: [] });

    expect(decision).toMatchObject({ engine: "pi", reason: "admitted" });
    expect(admission.decide("tenant-canary", "job-1")).toBe(decision);
  });

  it("halts expansion on a threshold breach and preserves the triggering evidence", () => {
    const evidence: CanaryEvidence[] = [];
    const admission = createCanaryAdmission(
      {
        enabled: true,
        allowlist: ["tenant-a", "tenant-b"],
        thresholds: { minimumJobs: 2, maximumFailureRate: 0.25 },
      },
      { preserve: (entry) => evidence.push(entry) },
    );

    admission.decide("tenant-a", "job-1");
    admission.decide("tenant-a", "job-2");
    admission.record({
      tenantId: "tenant-a",
      jobId: "job-1",
      outcome: "succeeded",
    });
    const breach = admission.record({
      tenantId: "tenant-a",
      jobId: "job-2",
      outcome: "failed",
    });

    expect(breach).toMatchObject({
      status: "halted",
      sampleSize: 2,
      failures: 1,
    });
    expect(admission.decide("tenant-b", "job-3")).toMatchObject({
      engine: "codex",
      reason: "canary-halted",
    });
    expect(evidence).toEqual([breach]);
    expect(Object.isFrozen(evidence[0]!)).toBe(true);
  });
});
