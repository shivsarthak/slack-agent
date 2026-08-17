import { describe, expect, it } from "vitest";
import { createApprovalCoordinator } from "../src/approvals/coordinator.ts";
import { openApprovalStore } from "../src/approvals/store.ts";
import type { PlannedAction } from "../src/ports/engine.ts";
import { threadKey } from "../src/thread.ts";
import { FakeClock, FakeSlack } from "./support/fakes.ts";
import { testTempDir } from "./support/test-root.ts";
import path from "node:path";

const thread = { channel: "C1", ts: "1.0" };
const action: PlannedAction = {
  id: "engine-action", source: "command", operation: "gh",
  target: { service: "github", resource: "acme/shop#42", environment: "shared" },
  arguments: ["gh", "pr", "merge", "42", "--token", "secret-value"], preview: "merge PR 42 with token secret-value",
  effect: "consequential", risk: "Merges a pull request.", grantScope: "github merge_pull_request acme/shop#42",
};

describe("approval coordinator", () => {
  it("pauses, exposes exactly three opaque actions, and lets only the requester decide once", async () => {
    const clock = new FakeClock();
    const slack = new FakeSlack(clock);
    const store = await openApprovalStore({ filePath: path.join(await testTempDir("approval-coordinator-"), "state.json") });
    const coordinator = createApprovalCoordinator({ config: { mode: "coworker", rules: [] }, slack, store, clock, log: { info() {}, warn() {} } });
    const waiting = coordinator.authorize(action, { request: "merge PR 42", trustedHumanMessages: [], threadKey: threadKey(thread), requesterUserId: "U1", workspaceDirectory: "/work" }, thread);
    while (slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const posted = slack.approvalPosts[0]!;
    expect(posted.actions.map((item) => item.label)).toEqual(["Approve once", "Allow similar in this Thread", "Deny"]);
    expect(posted.actions.every((item) => item.value !== action.id && !item.value.includes("merge"))).toBe(true);
    expect(posted.preview).not.toContain("secret-value");

    expect((await coordinator.decide({ requestId: posted.requestId, userId: "U2", decision: "approve-once", thread })).status).toBe("unauthorized");
    expect((await coordinator.decide({ requestId: posted.requestId, userId: "U1", decision: "approve-once", thread })).status).toBe("resolved");
    expect(await waiting).toBe("allow");
    expect((await coordinator.decide({ requestId: posted.requestId, userId: "U1", decision: "deny", thread })).status).toBe("already-decided");
  });

  it("denies and invalidates a pending action when its Turn is aborted", async () => {
    const clock = new FakeClock(); const slack = new FakeSlack(clock);
    const store = await openApprovalStore({ filePath: path.join(await testTempDir("approval-coordinator-"), "state.json") });
    const coordinator = createApprovalCoordinator({ config: { mode: "coworker", rules: [] }, slack, store, clock, log: { info() {}, warn() {} } });
    const abort = new AbortController();
    const waiting = coordinator.authorize(action, { request: "merge PR 42", trustedHumanMessages: [], threadKey: threadKey(thread), requesterUserId: "U1", workspaceDirectory: "/work" }, thread, abort.signal);
    while (slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    expect(await waiting).toBe("deny");
    expect(await store.isInactive(slack.approvalPosts[0]!.requestId)).toBe(true);
  });

  it("resolves concurrent duplicate deliveries exactly once", async () => {
    const clock = new FakeClock(); const slack = new FakeSlack(clock);
    const store = await openApprovalStore({ filePath: path.join(await testTempDir("approval-coordinator-"), "state.json") });
    const coordinator = createApprovalCoordinator({ config: { mode: "coworker", rules: [] }, slack, store, clock, log: { info() {}, warn() {} } });
    const waiting = coordinator.authorize(action, { request: "merge PR 42", trustedHumanMessages: [], threadKey: threadKey(thread), requesterUserId: "U1", workspaceDirectory: "/work" }, thread);
    while (slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const requestId = slack.approvalPosts[0]!.requestId;
    const results = await Promise.all([
      coordinator.decide({ requestId, userId: "U1", decision: "approve-once", thread }),
      coordinator.decide({ requestId, userId: "U1", decision: "deny", thread }),
    ]);
    expect(results.filter((result) => result.status === "resolved")).toHaveLength(1);
    expect(await waiting).toBe("allow");
  });
});
