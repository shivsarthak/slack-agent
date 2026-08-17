import { describe, expect, it } from "vitest";
import { decideApproval, grantKeyFor } from "../src/approvals/policy.ts";
import type { GoalContext, PlannedAction } from "../src/ports/engine.ts";

const goal: GoalContext = {
  request: "Fix the checkout bug and open a pull request",
  trustedHumanMessages: [],
  threadKey: "C1:1.0",
  requesterUserId: "U1",
  workspaceDirectory: "/work/job",
};

function action(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    id: "a1",
    source: "mcp",
    operation: "create_pull_request",
    target: { service: "github", resource: "acme/shop", environment: "shared" },
    arguments: { owner: "acme", repo: "shop" },
    preview: "github.create_pull_request acme/shop",
    effect: "external-mutation",
    risk: "Creates a reversible pull request.",
    grantScope: "github create_pull_request in acme/shop",
    ...overrides,
  };
}

describe("approval policy", () => {
  it("allows proven reads and goal-aligned ordinary work in coworker mode", async () => {
    expect((await decideApproval({ mode: "coworker", rules: [] }, goal, action({ effect: "read" }))).decision).toBe("allow");
    expect((await decideApproval({ mode: "coworker", rules: [] }, goal, action())).decision).toBe("allow");
  });

  it("asks for every unexempted external mutation in external-writes mode", async () => {
    expect((await decideApproval({ mode: "external-writes", rules: [] }, goal, action())).decision).toBe("ask");
  });

  it.each(["consequential", "unknown"] as const)("asks for %s actions in guarded modes", async (effect) => {
    expect((await decideApproval({ mode: "coworker", rules: [] }, goal, action({ effect }))).decision).toBe("ask");
  });

  it("never lets a grant or allow rule weaken a fixed consequence boundary", async () => {
    const merge = action({ source: "command", operation: "gh", effect: "consequential", arguments: ["gh", "pr", "merge", "42"] });
    const key = grantKeyFor(merge);
    const result = await decideApproval(
      { mode: "coworker", rules: [{ decision: "allow", source: "command", commandPrefix: ["gh", "pr", "merge"] }] },
      goal,
      merge,
      [{ threadKey: goal.threadKey, key, approvedBy: "U1", createdAt: 1, sourceRequest: goal.request }],
    );
    expect(result.decision).toBe("ask");
  });

  it("matches a grant only to the same thread and normalized narrow action", async () => {
    const current = action();
    const grant = { threadKey: goal.threadKey, key: grantKeyFor(current), approvedBy: "U1", createdAt: 1, sourceRequest: goal.request };
    expect((await decideApproval({ mode: "external-writes", rules: [] }, goal, current, [grant])).decision).toBe("allow");
    expect((await decideApproval({ mode: "external-writes", rules: [] }, { ...goal, threadKey: "C1:2.0" }, current, [grant])).decision).toBe("ask");
    expect((await decideApproval({ mode: "external-writes", rules: [] }, goal, action({ target: { service: "github", resource: "acme/other", environment: "shared" } }), [grant])).decision).toBe("ask");
  });

  it("lets contextual policy tune ordinary actions and fails closed to ask", async () => {
    const ordinary = action();
    const allow = { review: async () => ({ decision: "allow", source: "goal", rationale: "Policy names this repository." } as const) };
    expect((await decideApproval({ mode: "coworker", policy: "Allow acme/shop PRs", rules: [] }, goal, ordinary, [], allow)).decision).toBe("allow");
    const broken = { review: async () => { throw new Error("reviewer unavailable"); } };
    expect((await decideApproval({ mode: "coworker", policy: "Allow acme/shop PRs", rules: [] }, goal, ordinary, [], broken)).decision).toBe("ask");
  });

  it("does not let contextual policy weaken the external-writes fallback", async () => {
    let reviewed = false;
    const allow = {
      review: async () => {
        reviewed = true;
        return { decision: "allow", source: "goal", rationale: "Policy names this repository." } as const;
      },
    };

    const decision = await decideApproval(
      { mode: "external-writes", policy: "Allow acme/shop PRs", rules: [] },
      goal,
      action(),
      [],
      allow,
    );

    expect(decision).toMatchObject({ decision: "ask", source: "mode" });
    expect(reviewed).toBe(false);
  });

  it("auto-allows local workspace mutations before consulting the contextual reviewer", async () => {
    let reviewed = false;
    const unavailable = {
      review: async () => {
        reviewed = true;
        throw new Error("reviewer unavailable");
      },
    };
    const edit = action({
      source: "file-change",
      operation: "apply_patch",
      target: { service: "filesystem", resource: goal.workspaceDirectory, environment: "local" },
      workingDirectory: goal.workspaceDirectory,
      preview: "Apply proposed file changes",
      effect: "local-mutation",
      risk: "Changes files in the Job workspace.",
      grantScope: `file changes under ${goal.workspaceDirectory}`,
    });

    const explanationGoal = { ...goal, request: "Explain how the checkout currently works" };
    const fileDecision = await decideApproval(
      { mode: "coworker", policy: "Production changes require approval.", rules: [] },
      explanationGoal,
      edit,
      [],
      unavailable,
    );

    const commandDecision = await decideApproval(
      { mode: "coworker", policy: "Production changes require approval.", rules: [] },
      explanationGoal,
      action({
        source: "command",
        operation: "git",
        target: { service: "github", resource: goal.workspaceDirectory, environment: "local" },
        arguments: ["git", "commit", "-m", "local change"],
        workingDirectory: goal.workspaceDirectory,
        preview: "git commit -m local-change",
        effect: "local-mutation",
        risk: "Runs a command in the Job workspace.",
        grantScope: "command git in the Job workspace",
      }),
      [],
      unavailable,
    );

    expect(fileDecision).toMatchObject({ decision: "allow", source: "goal" });
    expect(commandDecision).toMatchObject({ decision: "allow", source: "goal" });
    expect(reviewed).toBe(false);
  });

  it("does not treat a filesystem mutation outside the Job workspace as local", async () => {
    const unavailable = { review: async () => { throw new Error("reviewer unavailable"); } };
    const decision = await decideApproval(
      { mode: "coworker", policy: "Production changes require approval.", rules: [] },
      goal,
      action({
        source: "file-change",
        operation: "apply_patch",
        target: { service: "filesystem", resource: "/etc", environment: "local" },
        workingDirectory: goal.workspaceDirectory,
        preview: "Apply proposed file changes",
        effect: "local-mutation",
        risk: "Changes files outside the Job workspace.",
        grantScope: "file changes under /etc",
      }),
      [],
      unavailable,
    );

    expect(decision).toMatchObject({ decision: "ask", source: "unknown" });
  });

  it("applies explicit ask before a contextual allow", async () => {
    const allow = { review: async () => ({ decision: "allow", source: "goal", rationale: "Policy allows it." } as const) };
    const result = await decideApproval(
      { mode: "coworker", policy: "Allow PRs", rules: [{ source: "mcp", server: "github", tool: "create_pull_request", decision: "ask" }] },
      goal, action(), [], allow,
    );
    expect(result.decision).toBe("ask");
  });
});
