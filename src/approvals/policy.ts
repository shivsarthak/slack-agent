import { createHash } from "node:crypto";
import path from "node:path";
import type { ApprovalConfig, ApprovalRule } from "../config.ts";
import type { GoalContext, PlannedAction } from "../ports/engine.ts";

export interface ThreadGrant {
  threadKey: string;
  key: string;
  approvedBy: string;
  createdAt: number;
  sourceRequest: string;
}

export interface ApprovalDecision {
  decision: "allow" | "ask" | "deny";
  rationale: string;
  source: "off" | "hard-floor" | "fixed-boundary" | "rule" | "grant" | "read" | "goal" | "mode" | "unknown";
  grantKey?: string | undefined;
}

export interface ContextualReviewer {
  review(input: { config: ApprovalConfig; goal: GoalContext; action: PlannedAction }): Promise<ApprovalDecision>;
}

/** Stable exact fallback; deliberately contains no fuzzy or model-derived component. */
export function grantKeyFor(action: PlannedAction): string {
  const canonical = JSON.stringify({
    source: action.source,
    operation: action.operation,
    environment: action.target.environment,
    service: action.target.service,
    resource: action.target.resource,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function decideApproval(
  config: ApprovalConfig,
  goal: GoalContext,
  action: PlannedAction,
  grants: readonly ThreadGrant[] = [],
  reviewer?: ContextualReviewer,
): Promise<ApprovalDecision> {
  const key = grantKeyFor(action);
  if (hardForbidden(action)) return result("deny", "hard-floor", "The action crosses a disabled safety floor.");

  const matching = config.rules.filter((rule) => matches(rule, action));
  if (matching.some((rule) => rule.decision === "deny")) return result("deny", "rule", "An operator deny rule matches this action.");

  if (config.mode !== "off" && fixedBoundary(action)) return { ...result("ask", "fixed-boundary", "This action crosses a fixed consequence boundary."), grantKey: key };
  if (matching.some((rule) => rule.decision === "ask")) return { ...result(config.mode === "off" ? "allow" : "ask", "rule", "An operator ask rule matches this action."), grantKey: key };

  if (config.mode === "off") return result("allow", "off", "Approval mode is off.");
  if (matching.some((rule) => rule.decision === "allow")) return result("allow", "rule", "A narrow operator allow rule matches this action.");
  if (grants.some((grant) => grant.threadKey === goal.threadKey && grant.key === key)) return result("allow", "grant", "A narrow grant in this Thread matches this action.");
  if (action.effect === "read") return result("allow", "read", "The action is proven read-only.");
  if (isLocalWorkspaceMutation(goal, action)) return result("allow", "goal", "This action is confined to the Job workspace.");
  if (config.mode === "external-writes" && action.effect === "external-mutation") {
    return { ...result("ask", "mode", "External writes require approval in external-writes mode."), grantKey: key };
  }

  if (reviewer !== undefined) {
    try {
      const reviewed = await reviewer.review({ config, goal, action });
      if (["allow", "ask", "deny"].includes(reviewed.decision)) return reviewed;
    } catch {
      // Availability and schema failures ask below.
    }
    return { ...result("ask", "unknown", "The contextual reviewer could not classify the action safely."), grantKey: key };
  }

  if (action.effect === "external-mutation" && config.mode === "coworker" && goalAligns(goal.request, action)) return result("allow", "goal", "This bounded reversible action matches the delegated Job.");
  return { ...result("ask", action.effect === "unknown" ? "unknown" : "mode", action.effect === "unknown" ? "The action is not understood well enough to allow." : "The action is not automatically authorized in this mode."), grantKey: key };
}

function isLocalWorkspaceMutation(goal: GoalContext, action: PlannedAction): boolean {
  if (action.effect !== "local-mutation" || action.target.environment !== "local") return false;
  if (action.source !== "file-change" && action.source !== "command") return false;
  if (action.source === "file-change" && action.target.service !== "filesystem") return false;

  const workspace = path.resolve(goal.workspaceDirectory);
  const workingDirectory = action.workingDirectory?.trim();
  if (workingDirectory === undefined || !within(workspace, workingDirectory)) return false;
  return within(workspace, action.target.resource);
}

function within(root: string, candidate: string): boolean {
  if (candidate.trim() === "") return false;
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function result(decision: ApprovalDecision["decision"], source: ApprovalDecision["source"], rationale: string): ApprovalDecision {
  return { decision, source, rationale };
}

function fixedBoundary(action: PlannedAction): boolean {
  if (action.effect === "consequential" || action.effect === "unknown") return true;
  if (action.effect === "local-mutation" && action.target.environment === "local") return false;
  const words = `${action.operation} ${action.preview}`.toLowerCase();
  return /(merge|close).*(pull|pr)|deploy|promot|rollback|restart.*prod|production|force[- ]?push|delete|destroy|reset --hard|no-verify|hooksPath|credential|secret|permission|billing|purchase|publish/.test(words);
}

function hardForbidden(action: PlannedAction): boolean {
  if (action.source === "permission") return true;
  return action.source === "mcp" && [
    "merge_pull_request", "merge_diff", "submit_diff_review", "delete_file",
    "delete_issue", "delete_comment", "delete_project", "delete_document",
  ].includes(action.operation);
}

function matches(rule: ApprovalRule, action: PlannedAction): boolean {
  if (rule.source !== action.source) return false;
  if (rule.server !== undefined && rule.server !== action.target.service) return false;
  if (rule.tool !== undefined && rule.tool !== action.operation) return false;
  if (rule.scope !== undefined && rule.scope !== action.target.resource) return false;
  if (rule.environment !== undefined && rule.environment !== action.target.environment) return false;
  if (rule.commandPrefix !== undefined) {
    const argv = Array.isArray(action.arguments) ? action.arguments.map(String) : [];
    if (!rule.commandPrefix.every((part, index) => argv[index] === part)) return false;
  }
  return true;
}

function goalAllowsMutation(request: string): boolean {
  return /\b(fix|build|implement|change|update|create|write|edit|add|remove|refactor)\b/i.test(request) && !/\b(investigate|review|explain|diagnose|plan)\b/i.test(request);
}

function goalAligns(request: string, action: PlannedAction): boolean {
  if (!goalAllowsMutation(request)) return false;
  const operation = action.operation.replaceAll("_", " ");
  if (/pull request|\bpr\b/i.test(operation)) return /pull request|\bpr\b|open/i.test(request);
  if (action.source === "command" && action.target.service === "github" && /\bpush\b/i.test(action.preview)) return /\b(fix|build|implement|change|publish|pull request|\bpr\b)\b/i.test(request);
  if (action.target.environment === "staging" && !/\bstag(e|ing)\b/i.test(request)) return false;
  const meaningful = operation.split(/\s+/).filter((word) => word.length > 3 && !["create", "update", "save", "post", "set"].includes(word));
  if (meaningful.some((word) => request.toLowerCase().includes(word.toLowerCase()))) return true;
  const resourceParts = action.target.resource.split(/[/#:]/).filter((part) => part.length > 2 && !/^\d+$/.test(part));
  return resourceParts.some((part) => request.toLowerCase().includes(part.toLowerCase()));
}
