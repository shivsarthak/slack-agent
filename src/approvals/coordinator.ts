import { randomBytes } from "node:crypto";
import type { ApprovalConfig } from "../config.ts";
import type { Clock } from "../ports/clock.ts";
import type { GoalContext, PlannedAction } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { Thread } from "../thread.ts";
import { decideApproval, grantKeyFor, type ContextualReviewer } from "./policy.ts";
import type { ApprovalStore } from "./store.ts";

export type HumanApprovalDecision = "approve-once" | "allow-similar" | "deny";
export interface ApprovalClick { requestId: string; userId: string; decision: HumanApprovalDecision; thread: Thread; }
export interface ApprovalClickResult { status: "resolved" | "unauthorized" | "already-decided" | "inactive"; }

interface Pending {
  requesterUserId: string; thread: Thread; messageTs: string; action: PlannedAction; goal: GoalContext;
  resolve: (decision: "allow" | "deny") => void; settled: boolean;
}

export function createApprovalCoordinator(deps: { config: ApprovalConfig; slack: SlackClient; store: ApprovalStore; clock: Clock; log: Logger; reviewer?: ContextualReviewer }): {
  authorize(action: PlannedAction, goal: GoalContext, thread: Thread, signal?: AbortSignal): Promise<"allow" | "deny">;
  decide(click: ApprovalClick): Promise<ApprovalClickResult>;
  cancelThread(threadKey: string): Promise<void>;
} {
  const pending = new Map<string, Pending>();

  const claim = (requestId: string, item: Pending): boolean => {
    if (item.settled) return false;
    item.settled = true; pending.delete(requestId); return true;
  };
  const finish = async (requestId: string, item: Pending, decision: "allow" | "deny", text: string): Promise<void> => {
    try { await deps.store.markInactive(requestId); }
    catch (error) { deps.log.warn(`Could not persist inactive approval ${requestId}: ${String(error)}`); }
    try { await deps.slack.settleApproval({ thread: item.thread, ts: item.messageTs, text }); }
    catch (error) { deps.log.warn(`Could not settle approval message ${requestId}: ${String(error)}`); }
    item.resolve(decision);
  };
  const settle = async (requestId: string, item: Pending, decision: "allow" | "deny", text: string): Promise<void> => {
    if (!claim(requestId, item)) return;
    await finish(requestId, item, decision, text);
  };

  return {
    async authorize(action, goal, thread, signal) {
      const policy = await decideApproval(deps.config, goal, action, await deps.store.grantsFor(goal.threadKey), deps.reviewer);
      deps.log.info(`Approval ${policy.decision} (${policy.source}) for ${action.source}:${action.operation} on ${action.target.service}/${action.target.resource}`);
      if (policy.decision !== "ask") return policy.decision;
      const requestId = randomBytes(24).toString("base64url");
      return new Promise<"allow" | "deny">((resolve) => {
        void (async () => {
          const posted = await deps.slack.postApproval({
            thread, requestId, category: action.source, target: `${action.target.service}/${action.target.resource}`,
            environment: action.target.environment, preview: redact(action.preview), effect: action.effect,
            risk: action.risk, reason: policy.rationale, grantScope: action.grantScope,
          });
          const item: Pending = { requesterUserId: goal.requesterUserId, thread, messageTs: posted.ts, action, goal, resolve, settled: false };
          pending.set(requestId, item);
          const abort = () => void settle(requestId, item, "deny", "Approval is no longer active; the Job stopped before a decision.");
          if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        })().catch((error: unknown) => { deps.log.warn(`Could not post approval request: ${String(error)}`); resolve("deny"); });
      });
    },
    async decide(click) {
      const item = pending.get(click.requestId);
      if (item === undefined) return { status: (await deps.store.isInactive(click.requestId)) ? "already-decided" : "inactive" };
      if (item.thread.channel !== click.thread.channel || item.thread.ts !== click.thread.ts) return { status: "inactive" };
      if (item.requesterUserId !== click.userId) {
        await deps.slack.postEphemeral({ thread: item.thread, userId: click.userId, text: "Only the person who delegated this Job can decide this approval." });
        return { status: "unauthorized" };
      }
      if (!claim(click.requestId, item)) return { status: "already-decided" };
      let allowed = click.decision !== "deny";
      if (click.decision === "allow-similar") {
        try { await deps.store.addGrant({ threadKey: item.goal.threadKey, key: grantKeyFor(item.action), approvedBy: click.userId, createdAt: deps.clock.now(), sourceRequest: item.goal.request }); }
        catch (error) { deps.log.warn(`Could not persist Thread Grant: ${String(error)}`); allowed = false; }
      }
      await finish(click.requestId, item, allowed ? "allow" : "deny", `${allowed ? "Approved" : "Denied"} by <@${click.userId}>${click.decision === "allow-similar" && allowed ? " · similar actions allowed in this Thread" : ""}.`);
      return { status: "resolved" };
    },
    async cancelThread(key) {
      await Promise.all([...pending].filter(([, item]) => item.goal.threadKey === key).map(([id, item]) => settle(id, item, "deny", "Approval is no longer active; the Job stopped.")));
    },
  };
}

function redact(value: string): string {
  return value.replace(/(bearer|token|password|secret)([ =:]+)[^\s]+/gi, "$1$2[REDACTED]").slice(0, 800);
}
