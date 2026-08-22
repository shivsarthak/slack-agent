import type { Engine, EngineEvent } from "../ports/engine.ts";
import type { ApprovalHandler } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import type { SessionStore } from "../ports/sessions.ts";
import { tenantId, type Tenant } from "../tenant.ts";
import type { Thread } from "../thread.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { McpServerConfig } from "../ports/mcp.ts";
import { createPiEngine } from "../engine/pi.ts";
import type { HostedToolAuditEntry } from "./local-tools.ts";
import {
  redact,
  type OperationalMetrics,
  type OperationalMetricName,
} from "./observability.ts";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { trackTurnDurability } from "../jobs/interruption.ts";
import type { DurableJob, JobLease } from "./postgres/job-queue.ts";
import type {
  AdmittedEngine,
  CanaryDecision,
  CanaryOutcome,
} from "./canary-admission.ts";

export interface WorkerQueue {
  claim(owner: string, leaseMs: number): Promise<JobLease | undefined>;
  renew(lease: JobLease, leaseMs: number): Promise<JobLease>;
  succeed(lease: JobLease): Promise<DurableJob>;
  fail(
    lease: JobLease,
    error: string,
    options?: { retryable: boolean },
  ): Promise<DurableJob>;
  get(tenantId: string, id: string): Promise<DurableJob | undefined>;
}

export interface JobResultDelivery {
  idempotencyKey: string;
  thread: Thread;
  text: string;
  outcome: "succeeded" | "failed";
}

/** Everything constructed from one Tenant's mount and credential file. */
export interface HostedJobRuntime {
  tenant: Tenant;
  /** Selected once per durable Job by the canary admission boundary. */
  engineName?: AdmittedEngine;
  engine: Engine;
  sessions: SessionStore;
  workspaceDirectory: string;
  writableDirectories?: readonly string[];
  authorize?: ApprovalHandler;
  deliverResult(result: JobResultDelivery): Promise<void>;
  close(): Promise<void>;
}

export interface HostedJobWorker {
  runOnce(): Promise<
    | { claimed: false }
    | {
        claimed: true;
        jobId: string;
        outcome:
          | "succeeded"
          | "retrying"
          | "failed"
          | "cancelled"
          | "lease-lost";
      }
  >;
}

/** Slack owns deduplication through client_msg_id at the external delivery seam. */
export function slackResultDelivery(
  slack: SlackClient,
): HostedJobRuntime["deliverResult"] {
  return async (result) => {
    await slack.postMessage({
      thread: result.thread,
      text: result.text,
      format: "markdown",
      idempotencyKey: result.idempotencyKey,
    });
  };
}

/** Bootstrap one worker from the already isolated Tenant mount and credentials. */
export function createMountedPiBootstrap(input: {
  tenantRoot: string;
  sessions: SessionStore;
  slack: SlackClient;
  mcpServers?: readonly McpServerConfig[];
  env: NodeJS.ProcessEnv;
  authorize?: ApprovalHandler;
  auditToolDecision?: (entry: HostedToolAuditEntry) => void | Promise<void>;
}): (lease: JobLease) => Promise<HostedJobRuntime> {
  return async (lease) => {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(lease.id))
      throw new Error("Job identifier is unsafe for the Tenant mount");
    const root = await realpath(input.tenantRoot);
    const vault = path.join(root, "vault");
    const sessions = path.join(root, "sessions");
    const workspace = path.join(root, "workspaces", lease.id);
    await Promise.all([
      mkdir(vault, { recursive: true }),
      mkdir(sessions, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    // PiEngine disables every built-in mutating tool. It registers only the wrapper's
    // rooted local tools and this Tenant's MCP inventory on each Session run.
    const engine = createPiEngine({
      sessionDirectory: sessions,
      agentDirectory: path.join(root, "agent"),
      mcpServers: input.mcpServers ?? [],
      env: input.env,
      auditToolDecision: input.auditToolDecision,
    });
    return {
      tenant: { id: tenantId(lease.tenantId) },
      engineName: "pi",
      engine,
      sessions: input.sessions,
      workspaceDirectory: workspace,
      writableDirectories: [vault],
      ...(input.authorize ? { authorize: input.authorize } : {}),
      deliverResult: slackResultDelivery(input.slack),
      close: async () => {},
    };
  };
}

/** Route a claimed Job through its stable Tenant canary decision. */
export function createCanaryBootstrap<T>(input: {
  admission: { decide(tenantId: string, jobId: string): CanaryDecision };
  pi(lease: JobLease): Promise<T>;
  codex(lease: JobLease): Promise<T>;
}): (lease: JobLease) => Promise<T & { engineName: AdmittedEngine }> {
  return async (lease) => {
    const decision = input.admission.decide(lease.tenantId, lease.id);
    const runtime = await input[decision.engine](lease);
    return { ...runtime, engineName: decision.engine };
  };
}

class LeaseLostError extends Error {
  constructor(message = "Job lease was lost") {
    super(message);
    this.name = "LeaseLostError";
  }
}

class JobCancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "JobCancelledError";
  }
}

export function createHostedJobWorker(input: {
  owner: string;
  leaseMs: number;
  queue: WorkerQueue;
  bootstrap(lease: JobLease): Promise<HostedJobRuntime>;
  log?: Logger;
  metrics?: OperationalMetrics;
  recordCanaryOutcome?: (outcome: CanaryOutcome) => void;
  classifyRetry?: (error: unknown) => "retryable" | "terminal";
}): HostedJobWorker {
  if (
    !input.owner ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs <= 0
  )
    throw new Error("Worker requires an owner and a positive lease duration");

  let busy = false;
  return {
    async runOnce() {
      if (busy) return { claimed: false } as const;
      busy = true;
      let claimed: JobLease | undefined;
      try {
        claimed = await input.queue.claim(input.owner, input.leaseMs);
      } catch (error) {
        busy = false;
        throw error;
      }
      if (!claimed) {
        busy = false;
        return { claimed: false } as const;
      }
      let lease = claimed;
      let runtime: HostedJobRuntime | undefined;
      const abort = new AbortController();
      let renewalFailure: unknown;
      let renewing = false;
      const renew = async (): Promise<void> => {
        if (renewing || renewalFailure) return;
        renewing = true;
        try {
          const job = await input.queue.get(lease.tenantId, lease.id);
          if (job?.status === "cancelled") throw new JobCancelledError();
          lease = await input.queue.renew(lease, input.leaseMs);
        } catch (error) {
          renewalFailure = isCancellation(error)
            ? error
            : new LeaseLostError(reason(error));
          abort.abort();
        } finally {
          renewing = false;
        }
      };
      const timer = setInterval(
        () => void renew(),
        Math.max(1, Math.floor(input.leaseMs / 3)),
      );
      timer.unref();
      log(input.log, "job.claimed", lease);
      metric("lease.claimed", lease, "claimed");

      try {
        runtime = await input.bootstrap(lease);
        assertTenant(runtime, lease);
        const thread = parseThread(lease.threadKey);
        const known = await runtime.sessions.get(runtime.tenant, thread);
        const engineName = runtime.engineName ?? "pi";
        if (known?.engine && known.engine !== engineName)
          throw new Error(
            `Hosted worker cannot resume ${known.engine} Session with ${engineName}`,
          );
        const options = {
          workingDirectory: runtime.workspaceDirectory,
          ...(runtime.writableDirectories
            ? { writableDirectories: runtime.writableDirectories }
            : {}),
        };
        const session = known
          ? runtime.engine.resumeSession(known.id, options, known.locator)
          : runtime.engine.startSession(options);
        metric(known ? "session.resumed" : "session.started", lease, "ok");
        const durability = trackTurnDurability({
          sessions: runtime.sessions,
          tenant: runtime.tenant,
          thread,
          known,
        });
        let answer = "";
        const prompt =
          known?.interrupted || lease.attempt > 1
            ? `${lease.request}\n\nThe previous Turn was interrupted and may have partially completed. Verify external state before repeating actions.`
            : lease.request;
        for await (const event of session.run(prompt, {
          signal: abort.signal,
          ...(runtime.authorize ? { onApproval: runtime.authorize } : {}),
        })) {
          await durability.observe(event);
          if (event.type === "message") answer = event.text;
          if (event.type === "turn-failed" || event.type === "engine-error")
            throw new Error(event.message);
        }
        await waitForRenewal();
        if (renewalFailure) throw renewalFailure;
        // Fence the externally visible result immediately before delivery. A stale
        // worker therefore cannot post after another worker has reclaimed its Job.
        lease = await input.queue.renew(lease, input.leaseMs).catch((error) => {
          throw new LeaseLostError(reason(error));
        });
        await runtime.deliverResult({
          idempotencyKey: `job:${lease.id}:result`,
          thread,
          text: answer || "The Job completed without a textual result.",
          outcome: "succeeded",
        });
        await input.queue.succeed(lease);
        if (runtime.engineName === "pi")
          recordCanaryOutcome({
            tenantId: lease.tenantId,
            jobId: lease.id,
            outcome: "succeeded",
          });
        log(input.log, "job.succeeded", lease);
        return {
          claimed: true,
          jobId: lease.id,
          outcome: "succeeded",
        } as const;
      } catch (error) {
        await waitForRenewal();
        const actual = renewalFailure ?? error;
        if (isCancellation(actual)) {
          log(input.log, "job.cancelled", lease, actual);
          return {
            claimed: true,
            jobId: lease.id,
            outcome: "cancelled",
          } as const;
        }
        if (actual instanceof LeaseLostError) {
          log(input.log, "job.lease-lost", lease, actual);
          metric("lease.lost", lease, "lost");
          return {
            claimed: true,
            jobId: lease.id,
            outcome: "lease-lost",
          } as const;
        }
        const retryable =
          (input.classifyRetry ?? classifyRetry)(actual) === "retryable";
        let failed: DurableJob;
        try {
          failed = await input.queue.fail(lease, reason(actual), { retryable });
        } catch (failure) {
          log(input.log, "job.lease-lost", lease, failure);
          return {
            claimed: true,
            jobId: lease.id,
            outcome: "lease-lost",
          } as const;
        }
        if (
          runtime &&
          (failed.status === "failed" || failed.status === "dead-letter")
        ) {
          await runtime.deliverResult({
            idempotencyKey: `job:${lease.id}:result`,
            thread: parseThread(lease.threadKey),
            text: `The Job failed: ${reason(actual)}`,
            outcome: "failed",
          });
        }
        log(
          input.log,
          retryable ? "job.retrying" : "job.failed",
          lease,
          actual,
        );
        if (failed.status === "queued") metric("job.retry", lease, "retrying");
        if (failed.status === "dead-letter")
          metric("job.dead-letter", lease, "failed");
        if (runtime?.engineName === "pi" && failed.status !== "queued")
          recordCanaryOutcome({
            tenantId: lease.tenantId,
            jobId: lease.id,
            outcome: "failed",
          });
        return {
          claimed: true,
          jobId: lease.id,
          outcome: failed.status === "queued" ? "retrying" : "failed",
        } as const;
      } finally {
        clearInterval(timer);
        abort.abort();
        if (runtime) {
          await runtime.engine.close().catch(() => undefined);
          await runtime.close().catch(() => undefined);
        }
        busy = false;
      }

      async function waitForRenewal(): Promise<void> {
        while (renewing)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      function metric(
        name: OperationalMetricName,
        job: JobLease,
        outcome: string,
      ): void {
        input.metrics?.increment(name, {
          tenantId: job.tenantId,
          jobId: job.id,
          outcome,
        });
      }

      function recordCanaryOutcome(outcome: CanaryOutcome): void {
        try {
          input.recordCanaryOutcome?.(outcome);
        } catch (error) {
          input.log?.warn(
            JSON.stringify({
              event: "canary.evidence-failed",
              tenantId: outcome.tenantId,
              jobId: outcome.jobId,
              error: redact(reason(error)),
            }),
          );
        }
      }
    },
  };
}

function parseThread(value: string): Thread {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Invalid Job Thread key: ${value}`);
  return { channel: value.slice(0, separator), ts: value.slice(separator + 1) };
}

function assertTenant(runtime: HostedJobRuntime, lease: JobLease): void {
  if (runtime.tenant.id !== lease.tenantId)
    throw new Error("Tenant bootstrap returned a different Tenant");
  if (
    (runtime.engineName ?? "pi") === "pi" &&
    runtime.engine.sandbox.mode !== "external-tenant-isolation"
  )
    throw new Error(
      "Hosted Jobs require Pi's external Tenant isolation posture",
    );
}

function classifyRetry(error: unknown): "retryable" | "terminal" {
  const message = reason(error);
  return /(?:timeout|timed out|rate limit|429|5\d\d|temporar|connection|socket|econn|network)/i.test(
    message,
  )
    ? "retryable"
    : "terminal";
}

function isCancellation(error: unknown): error is JobCancelledError {
  return error instanceof JobCancelledError;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(
  logger: Logger | undefined,
  event: string,
  lease: JobLease,
  error?: unknown,
): void {
  logger?.info(
    JSON.stringify({
      event,
      tenantId: lease.tenantId,
      jobId: lease.id,
      attempt: lease.attempt,
      leaseOwner: lease.leaseOwner,
      ...(error === undefined ? {} : { error: redact(reason(error)) }),
    }),
  );
}
