import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import { slackClientFor, subscribeToApprovalActions } from "../src/slack/gateway.ts";

describe("Slack channel resolution", () => {
  it("uses an explicit channel ID without requiring channel-directory scopes", async () => {
    const list = vi.fn(async () => { throw new Error("missing_scope"); });
    const app = { client: { conversations: { list } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await expect(slack.resolveWritableChannel("<#C0347LT2MR6|random>"))
      .resolves.toEqual({ id: "C0347LT2MR6", name: "random" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("Slack message formatting", () => {
  it("sends model answers through Slack's standard Markdown field", async () => {
    const postMessage = vi.fn(async (_input: unknown) => ({ ts: "1700000000.000100" }));
    const app = { client: { chat: { postMessage } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await slack.postMessage({
      thread: { channel: "C_PLATFORM", ts: "1699999999.000100" },
      text: "## Result\n\n| State | Count |\n| --- | ---: |\n| Open | 3 |",
      format: "markdown",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_PLATFORM",
      thread_ts: "1699999999.000100",
      markdown_text: "## Result\n\n| State | Count |\n| --- | ---: |\n| Open | 3 |",
    });
  });

  it("keeps app-authored operational messages on mrkdwn by default", async () => {
    const postMessage = vi.fn(async () => ({ ts: "1700000000.000100" }));
    const app = { client: { chat: { postMessage } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await slack.postMessage({
      thread: { channel: "C_PLATFORM", ts: "1699999999.000100" },
      text: "*Working*",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_PLATFORM",
      thread_ts: "1699999999.000100",
      text: "*Working*",
    });
  });

  it("renders the exact three approval buttons with opaque values and fallback text", async () => {
    const postMessage = vi.fn(async (_input: unknown) => ({ ts: "1700000000.000100" }));
    const app = { client: { chat: { postMessage } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");
    await slack.postApproval({
      thread: { channel: "C_PLATFORM", ts: "1699999999.000100" }, requestId: "opaque-id",
      category: "command", target: "github/acme/shop", environment: "shared", preview: "gh pr merge 42",
      effect: "consequential", risk: "Merges a pull request.", reason: "Fixed boundary.", grantScope: "this repository action",
    });
    const sent = postMessage.mock.calls[0]![0] as { text: string; blocks: { type: string; elements?: { action_id: string; value: string }[] }[] };
    expect(sent.text).toMatch(/Approval required.*Job is paused/);
    const actions = sent.blocks.find((block) => block.type === "actions")!.elements!;
    expect(actions.map((action) => action.action_id)).toEqual(["approval_approve_once", "approval_allow_similar", "approval_deny"]);
    expect(actions.map((action) => action.value)).toEqual(["opaque-id", "opaque-id", "opaque-id"]);
  });
});

describe("Slack approval actions", () => {
  it("acknowledges before starting asynchronous policy work", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<void>>();
    const app = { action: (id: string, handler: (args: unknown) => Promise<void>) => handlers.set(id, handler) } as unknown as App;
    const order: string[] = [];
    subscribeToApprovalActions(app, async () => { order.push("decide"); return { status: "resolved" }; }, { info() {}, warn() {} });
    await handlers.get("approval_approve_once")!({
      ack: async () => { order.push("ack"); },
      action: { value: "opaque-id" }, body: { user: { id: "U1" }, channel: { id: "C1" }, message: { thread_ts: "1.0" } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["ack", "decide"]);
  });
});
