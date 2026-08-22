export interface ReleaseIdentity {
  readonly commitSha: string;
  readonly artifactDigest: string;
}

export interface QualificationCheck {
  readonly passed: boolean;
  readonly evidence: string;
}

export interface QualifiedRelease {
  readonly status: "qualified";
  readonly identity: ReleaseIdentity;
  readonly qualifiedAt: string;
  readonly evidence: Readonly<{
    verification: string;
    migration: string;
    rollback: string;
  }>;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Create the immutable identity used by every later release gate. */
export function releaseIdentity(input: {
  commitSha: string;
  artifactDigest: string;
}): ReleaseIdentity {
  if (
    !COMMIT_SHA.test(input.commitSha) ||
    !ARTIFACT_DIGEST.test(input.artifactDigest)
  )
    throw new Error(
      "Release identity must use an immutable commit SHA and sha256 artifact digest",
    );
  return Object.freeze({ ...input });
}

/** Refuse a live-gate manifest unless all automated release checks passed. */
export function qualifyRelease(input: {
  identity: ReleaseIdentity;
  verification: QualificationCheck;
  migration: QualificationCheck;
  rollback: QualificationCheck;
  qualifiedAt: string;
}): QualifiedRelease {
  const identity = releaseIdentity(input.identity);
  if (Number.isNaN(Date.parse(input.qualifiedAt)))
    throw new Error("Release qualification time must be an ISO timestamp");
  for (const name of ["verification", "migration", "rollback"] as const) {
    const check = input[name];
    if (!check.passed || check.evidence.trim() === "")
      throw new Error(`Release ${name} check has not passed with evidence`);
  }
  const evidence = Object.freeze({
    verification: input.verification.evidence,
    migration: input.migration.evidence,
    rollback: input.rollback.evidence,
  });
  return Object.freeze({
    status: "qualified",
    identity,
    qualifiedAt: input.qualifiedAt,
    evidence,
  });
}
