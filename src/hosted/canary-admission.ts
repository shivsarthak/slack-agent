export type AdmittedEngine = "pi" | "codex";
export type AdmissionReason =
  | "admitted"
  | "feature-disabled"
  | "tenant-not-allowlisted"
  | "canary-halted";

export interface CanaryDecision {
  readonly tenantId: string;
  readonly jobId: string;
  readonly engine: AdmittedEngine;
  readonly reason: AdmissionReason;
}

export interface CanaryOutcome {
  readonly tenantId: string;
  readonly jobId: string;
  readonly outcome: "succeeded" | "failed";
}

export interface CanaryEvidence {
  readonly status: "halted";
  readonly reason: "failure-rate-threshold";
  readonly sampleSize: number;
  readonly failures: number;
  readonly failureRate: number;
  readonly threshold: number;
  readonly samples: readonly CanaryOutcome[];
}

export interface CanaryConfiguration {
  readonly enabled: boolean;
  readonly allowlist: readonly string[];
}

export interface CanaryThresholds {
  readonly minimumJobs: number;
  readonly maximumFailureRate: number;
}

export function createCanaryAdmission(
  initial: CanaryConfiguration & { thresholds: CanaryThresholds },
  evidence: { preserve(entry: CanaryEvidence): void } = { preserve: () => {} },
) {
  validateThresholds(initial.thresholds);
  let configuration = normalizeConfiguration(initial);
  const decisions = new Map<string, CanaryDecision>();
  const outcomes = new Map<string, CanaryOutcome>();
  let halt: CanaryEvidence | undefined;

  return {
    configure(next: CanaryConfiguration): void {
      configuration = normalizeConfiguration(next);
    },
    decide(tenantId: string, jobId: string): CanaryDecision {
      const key = decisionKey(tenantId, jobId);
      const existing = decisions.get(key);
      if (existing) return existing;
      const reason: AdmissionReason = halt
        ? "canary-halted"
        : !configuration.enabled
          ? "feature-disabled"
          : !configuration.allowlist.has(tenantId)
            ? "tenant-not-allowlisted"
            : "admitted";
      const decision = Object.freeze({
        tenantId,
        jobId,
        engine: reason === "admitted" ? "pi" : "codex",
        reason,
      } satisfies CanaryDecision);
      decisions.set(key, decision);
      return decision;
    },
    record(sample: CanaryOutcome): CanaryEvidence | undefined {
      if (halt) return halt;
      const key = decisionKey(sample.tenantId, sample.jobId);
      if (decisions.get(key)?.engine !== "pi")
        throw new Error(
          "Canary telemetry accepts only Jobs previously admitted to Pi",
        );
      if (!outcomes.has(key)) outcomes.set(key, Object.freeze({ ...sample }));
      const samples = [...outcomes.values()];
      const failures = samples.filter(
        ({ outcome }) => outcome === "failed",
      ).length;
      const failureRate = failures / samples.length;
      if (
        samples.length >= initial.thresholds.minimumJobs &&
        failureRate > initial.thresholds.maximumFailureRate
      ) {
        halt = Object.freeze({
          status: "halted",
          reason: "failure-rate-threshold",
          sampleSize: samples.length,
          failures,
          failureRate,
          threshold: initial.thresholds.maximumFailureRate,
          samples: Object.freeze(samples),
        });
        evidence.preserve(halt);
      }
      return halt;
    },
    status: (): "active" | "halted" => (halt ? "halted" : "active"),
  };
}

function normalizeConfiguration(configuration: CanaryConfiguration) {
  return {
    enabled: configuration.enabled,
    allowlist: new Set(configuration.allowlist),
  };
}

function validateThresholds(thresholds: CanaryThresholds): void {
  if (
    !Number.isSafeInteger(thresholds.minimumJobs) ||
    thresholds.minimumJobs <= 0
  )
    throw new Error("Canary minimumJobs must be a positive integer");
  if (thresholds.maximumFailureRate < 0 || thresholds.maximumFailureRate > 1)
    throw new Error("Canary maximumFailureRate must be between zero and one");
}

function decisionKey(tenantId: string, jobId: string): string {
  if (!tenantId || !jobId)
    throw new Error("Canary admission requires Tenant and Job identity");
  return `${tenantId}\0${jobId}`;
}
