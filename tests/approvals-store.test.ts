import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openApprovalStore } from "../src/approvals/store.ts";
import { testTempDir } from "./support/test-root.ts";

describe("approval state", () => {
  it("persists narrow Thread grants atomically and reloads them", async () => {
    const stateDir = await testTempDir("approval-state-");
    const first = await openApprovalStore({ filePath: path.join(stateDir, "approvals.json") });
    await first.addGrant({ threadKey: "C1:1", key: "exact-key", approvedBy: "U1", createdAt: 42, sourceRequest: "open a PR" });

    const reopened = await openApprovalStore({ filePath: path.join(stateDir, "approvals.json") });
    expect(await reopened.grantsFor("C1:1")).toEqual([{ threadKey: "C1:1", key: "exact-key", approvedBy: "U1", createdAt: 42, sourceRequest: "open a PR" }]);
    expect(await reopened.grantsFor("C1:2")).toEqual([]);
    expect(JSON.parse(await readFile(path.join(stateDir, "approvals.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("remembers inactive request ids after restart without persisting action payloads", async () => {
    const filePath = path.join(await testTempDir("approval-state-"), "approvals.json");
    const first = await openApprovalStore({ filePath });
    await first.markInactive("opaque-id");
    const reopened = await openApprovalStore({ filePath });
    expect(await reopened.isInactive("opaque-id")).toBe(true);
    expect(await readFile(filePath, "utf8")).not.toContain("command");
  });
});
