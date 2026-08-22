import { describe, expect, it } from "vitest";
import {
  qualifyRelease,
  releaseIdentity,
} from "../src/hosted/release-qualification.ts";

describe("release qualification", () => {
  const identity = releaseIdentity({
    commitSha: "9988c414879d85b3b392c7b6e1b8d5ca518b2f11",
    artifactDigest: `sha256:${"a".repeat(64)}`,
  });

  it("binds a qualified release to an immutable commit and artifact digest", () => {
    const result = qualifyRelease({
      identity,
      verification: { passed: true, evidence: "ci/run/123" },
      migration: { passed: true, evidence: "ci/run/123#migration" },
      rollback: { passed: true, evidence: "ci/run/123#rollback" },
      qualifiedAt: "2026-08-23T10:00:00.000Z",
    });

    expect(result).toEqual({
      status: "qualified",
      identity,
      qualifiedAt: "2026-08-23T10:00:00.000Z",
      evidence: {
        verification: "ci/run/123",
        migration: "ci/run/123#migration",
        rollback: "ci/run/123#rollback",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(["verification", "migration", "rollback"] as const)(
    "refuses qualification when %s has not passed",
    (failed) => {
      expect(() =>
        qualifyRelease({
          identity,
          verification: {
            passed: failed !== "verification",
            evidence: "verify",
          },
          migration: { passed: failed !== "migration", evidence: "migration" },
          rollback: { passed: failed !== "rollback", evidence: "rollback" },
          qualifiedAt: "2026-08-23T10:00:00.000Z",
        }),
      ).toThrow(new RegExp(failed, "i"));
    },
  );

  it("rejects mutable release identifiers", () => {
    expect(() =>
      releaseIdentity({ commitSha: "main", artifactDigest: "latest" }),
    ).toThrow(/immutable/i);

    expect(() =>
      qualifyRelease({
        identity: { commitSha: "main", artifactDigest: "latest" },
        verification: { passed: true, evidence: "verify" },
        migration: { passed: true, evidence: "migration" },
        rollback: { passed: true, evidence: "rollback" },
        qualifiedAt: "2026-08-23T10:00:00.000Z",
      }),
    ).toThrow(/immutable/i);
  });
});
