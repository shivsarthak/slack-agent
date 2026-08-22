import { describe, expect, it } from "vitest";
import type { PlannedAction } from "../src/ports/engine.ts";
import { coworkerHarness } from "./support/harness.ts";

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    id: "a1", source: "command", operation: "gh",
    target: { service: "github", resource: "acme/shop#42", environment: "shared" },
    arguments: ["gh", "pr", "merge", "42"], preview: "gh pr merge 42 in acme/shop",
    effect: "consequential", risk: "Merges a pull request.", grantScope: "merge pull request 42 in acme/shop",
    ...overrides,
  };
}

describe("a Job awaiting approval", () => {
  it("does not pause for a mutation confined to the Job workspace", async () => {
    const h = await coworkerHarness({
      approvals: {
        mode: "external-writes",
        policy: "All external writes require approval.",
        rules: [],
      },
    });
    h.engine.script = async ({ requestApproval, workingDirectory }) => {
      const decision = await requestApproval(planned({
        source: "file-change",
        operation: "apply_patch",
        target: { service: "filesystem", resource: workingDirectory, environment: "local" },
        arguments: {},
        workingDirectory,
        preview: "Apply proposed file changes",
        effect: "local-mutation",
        risk: "Changes files in the Job workspace.",
        grantScope: `file changes under ${workingDirectory}`,
      }));
      return [{ type: "message", text: decision === "allow" ? "Changed locally." : "Paused." }];
    };

    const delivery = await h.startMention({ text: "<@U0COWORKER> explain this and make any useful local notes" });
    if (delivery.accepted) await delivery.completed;

    expect(h.slack.approvalPosts).toEqual([]);
    expect(h.slack.textsIn("1700000000.000100")).toContain("Changed locally.");
    expect(h.engine.oneOffTurns).toHaveLength(1);
  });

  it("does not execute before Approve once and resumes afterward", async () => {
    const h = await coworkerHarness(); let executed = false;
    h.engine.script = async ({ requestApproval }) => {
      const decision = await requestApproval(planned());
      if (decision === "allow") executed = true;
      return [{ type: "message", text: decision === "allow" ? "Merged." : "I did not merge." }];
    };
    const delivery = await h.startMention({ text: "<@U0COWORKER> merge PR 42" });
    while (h.slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    expect(executed).toBe(false);
    expect(h.slack.writes.some((write) => write.text.includes("Waiting for approval"))).toBe(true);
    const requestId = h.slack.approvalPosts[0]!.requestId;
    await h.coworker.handleApproval({ requestId, userId: "U_ASKER", decision: "approve-once", thread: h.slack.approvalPosts[0]!.thread });
    if (delivery.accepted) await delivery.completed;
    expect(executed).toBe(true);
    expect(h.slack.textsIn("1700000000.000100")).toContain("Merged.");
  });

  it("clears Slack's loading indicator while waiting on the human", async () => {
    const h = await coworkerHarness();
    h.engine.script = async ({ requestApproval }) => {
      const decision = await requestApproval(planned());
      return [{ type: "message", text: decision === "allow" ? "Merged." : "I did not merge." }];
    };
    const delivery = await h.startMention({ text: "<@U0COWORKER> merge PR 42" });
    while (h.slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    // Nothing is being generated while a human decides, so the native indicator —
    // which Slack renders as a "Generating response…" ghost message — must be off.
    expect(h.slack.statuses.at(-1)?.status).toBe("");
    await h.coworker.handleApproval({ requestId: h.slack.approvalPosts[0]!.requestId, userId: "U_ASKER", decision: "approve-once", thread: h.slack.approvalPosts[0]!.thread });
    if (delivery.accepted) await delivery.completed;
    expect(h.slack.textsIn("1700000000.000100")).toContain("Merged.");
  });

  it("returns a denial to the engine so it can finish via a safer path", async () => {
    const h = await coworkerHarness();
    h.engine.script = async ({ requestApproval }) => {
      const decision = await requestApproval(planned());
      return [{ type: "message", text: decision === "deny" ? "Prepared merge instructions instead." : "Merged." }];
    };
    const delivery = await h.startMention({ text: "<@U0COWORKER> merge PR 42" });
    while (h.slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await h.coworker.handleApproval({ requestId: h.slack.approvalPosts[0]!.requestId, userId: "U_ASKER", decision: "deny", thread: h.slack.approvalPosts[0]!.thread });
    if (delivery.accepted) await delivery.completed;
    expect(h.slack.textsIn("1700000000.000100")).toContain("Prepared merge instructions instead.");
  });

  it("persists a narrow similar-action grant for this Thread only", async () => {
    const h = await coworkerHarness({ approvals: { mode: "external-writes", rules: [] } });
    let resource = "acme/shop";
    h.engine.script = async ({ requestApproval }) => {
      const decision = await requestApproval(planned({
        operation: "create_pull_request", effect: "external-mutation",
        target: { service: "github", resource, environment: "shared" },
        preview: `github.create_pull_request ${resource}`, grantScope: `create_pull_request in ${resource}`,
      }));
      return [{ type: "message", text: decision === "allow" ? "Opened." : "Not opened." }];
    };
    const first = await h.startMention({ text: "<@U0COWORKER> implement this and open a PR" });
    while (h.slack.approvalPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await h.coworker.handleApproval({ requestId: h.slack.approvalPosts[0]!.requestId, userId: "U_ASKER", decision: "allow-similar", thread: h.slack.approvalPosts[0]!.thread });
    if (first.accepted) await first.completed;

    await h.mention({ text: "<@U0COWORKER> update the PR" });
    expect(h.slack.approvalPosts).toHaveLength(1);

    resource = "acme/other";
    const changed = await h.startMention({ text: "<@U0COWORKER> open the other PR" });
    while (h.slack.approvalPosts.length < 2) await new Promise((resolve) => setImmediate(resolve));
    expect(h.slack.approvalPosts).toHaveLength(2);
    await h.coworker.handleApproval({ requestId: h.slack.approvalPosts[1]!.requestId, userId: "U_ASKER", decision: "deny", thread: h.slack.approvalPosts[1]!.thread });
    if (changed.accepted) await changed.completed;
  });
});
