import { describe, expect, it, vi } from "vitest";
import { tenantId } from "../src/tenant.ts";
import {
  createHostedJobWorker,
  slackResultDelivery,
  type HostedJobRuntime,
  type WorkerQueue,
} from "../src/hosted/worker.ts";
import type { Engine, EngineEvent, EngineSession } from "../src/ports/engine.ts";
import type { JobLease } from "../src/hosted/postgres/job-queue.ts";

const lease = (overrides: Partial<JobLease> = {}): JobLease => ({
  id: "job-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  threadKey: "C1:1.2",
  request: "investigate",
  status: "running",
  attempt: 1,
  availableAt: new Date(0),
  leaseOwner: "worker-1",
  leaseToken: "token-1",
  leaseExpiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

function session(events: EngineEvent[], id = "pi-session"): EngineSession {
  return {
    id,
    locator: "/tenant/sessions/session.jsonl",
    async *run() {
      yield* events;
    },
  };
}

function harness(input: { existing?: { id: string; engine?: string; locator?: string; interrupted: boolean } } = {}) {
  const current = lease();
  const sessions: any[] = [];
  const deliveries: any[] = [];
  const started = session([
    { type: "session-started", sessionId: "pi-session", locator: "/tenant/sessions/session.jsonl", engine: "pi" },
    { type: "turn-started" },
    { type: "message", text: "Done." },
    { type: "turn-completed", usage: undefined },
  ]);
  const engine = {
    sandbox: { mode: "external-tenant-isolation", networkEnabled: true, execPolicy: "no built-in tools" },
    version: async () => "pi-test",
    startSession: vi.fn(() => started),
    resumeSession: vi.fn(() => started),
    startOneOffSession: vi.fn(() => started),
    close: vi.fn(async () => {}),
  } satisfies Engine;
  const queue: WorkerQueue = {
    claim: vi.fn(async () => current),
    renew: vi.fn(async (value) => value),
    succeed: vi.fn(async (value) => ({ ...value, status: "succeeded" as const })),
    fail: vi.fn(async (value) => ({ ...value, status: "queued" as const })),
    get: vi.fn(async () => current),
  };
  const runtime: HostedJobRuntime = {
    tenant: { id: tenantId(current.tenantId) },
    engine,
    workspaceDirectory: "/tenant/workspaces/job-1",
    writableDirectories: ["/tenant/vault"],
    sessions: {
      get: vi.fn(async () => input.existing),
      set: vi.fn(async (_tenant, _thread, value) => { sessions.push(value); }),
    },
    deliverResult: vi.fn(async (value) => { deliveries.push(value); }),
    close: vi.fn(async () => {}),
  };
  return { current, queue, runtime, engine, sessions, deliveries };
}

describe("hosted Pi Job worker", () => {
  it("runs one claimed Job, durably closes the Turn, and delivers once by Job key", async () => {
    const h = harness();
    const worker = createHostedJobWorker({
      owner: "worker-1",
      leaseMs: 30_000,
      queue: h.queue,
      bootstrap: vi.fn(async () => h.runtime),
    });

    expect(await worker.runOnce()).toEqual({ claimed: true, outcome: "succeeded", jobId: "job-1" });
    expect(h.engine.startSession).toHaveBeenCalledWith({
      workingDirectory: "/tenant/workspaces/job-1",
      writableDirectories: ["/tenant/vault"],
    });
    expect(h.sessions.at(-1)).toMatchObject({ id: "pi-session", engine: "pi", interrupted: false });
    expect(h.deliveries).toEqual([{ idempotencyKey: "job:job-1:result", thread: { channel: "C1", ts: "1.2" }, text: "Done.", outcome: "succeeded" }]);
    expect(h.queue.succeed).toHaveBeenCalledWith(h.current);
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it("resumes the persisted Pi Session and warns after an interrupted Turn", async () => {
    const h = harness({ existing: { id: "old", engine: "pi", locator: "/tenant/sessions/old.jsonl", interrupted: true } });
    let prompt = "";
    vi.mocked(h.engine.resumeSession).mockReturnValue({
      id: "old",
      locator: "/tenant/sessions/old.jsonl",
      async *run(value) {
        prompt = value;
        yield { type: "turn-completed", usage: undefined };
      },
    });
    const worker = createHostedJobWorker({ owner: "worker-1", leaseMs: 30_000, queue: h.queue, bootstrap: async () => h.runtime });
    await worker.runOnce();
    expect(h.engine.resumeSession).toHaveBeenCalledWith("old", expect.anything(), "/tenant/sessions/old.jsonl");
    expect(prompt).toContain("may have partially completed");
  });

  it("warns a reclaimed attempt even when Pi durably completed its prior Turn", async () => {
    const h = harness({ existing: { id: "old", engine: "pi", locator: "/tenant/sessions/old.jsonl", interrupted: false } });
    Object.assign(h.current, { attempt: 2 });
    let prompt = "";
    vi.mocked(h.engine.resumeSession).mockReturnValue({
      id: "old", locator: "/tenant/sessions/old.jsonl",
      async *run(value) { prompt = value; yield { type: "turn-completed", usage: undefined }; },
    });
    const worker = createHostedJobWorker({ owner: "worker-1", leaseMs: 30_000, queue: h.queue, bootstrap: async () => h.runtime });
    await worker.runOnce();
    expect(prompt).toContain("Verify external state before repeating actions");
  });

  it("does not deliver or complete after losing its lease", async () => {
    const h = harness();
    vi.mocked(h.queue.renew).mockRejectedValue(new Error("lease expired"));
    const worker = createHostedJobWorker({ owner: "worker-1", leaseMs: 30_000, queue: h.queue, bootstrap: async () => h.runtime });
    expect(await worker.runOnce()).toMatchObject({ outcome: "lease-lost" });
    expect(h.deliveries).toEqual([]);
    expect(h.queue.succeed).not.toHaveBeenCalled();
    expect(h.queue.fail).not.toHaveBeenCalled();
  });

  it("persists retryable failures without posting a final result", async () => {
    const h = harness();
    const broken = session([{ type: "engine-error", message: "network connection reset" }]);
    vi.mocked(h.engine.startSession).mockReturnValue(broken);
    const worker = createHostedJobWorker({ owner: "worker-1", leaseMs: 30_000, queue: h.queue, bootstrap: async () => h.runtime });
    expect(await worker.runOnce()).toMatchObject({ outcome: "retrying" });
    expect(h.queue.fail).toHaveBeenCalledWith(h.current, "network connection reset", { retryable: true });
    expect(h.deliveries).toEqual([]);
  });

  it("will not claim a second Job while its one Job is active", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(h.engine.startSession).mockReturnValue({
      id: "held", locator: "/tenant/sessions/held.jsonl",
      async *run() { await held; yield { type: "message", text: "done" } as EngineEvent; yield { type: "turn-completed", usage: undefined } as EngineEvent; },
    });
    const worker = createHostedJobWorker({ owner: "worker-1", leaseMs: 30_000, queue: h.queue, bootstrap: async () => h.runtime });
    const first = worker.runOnce();
    await vi.waitFor(() => expect(h.engine.startSession).toHaveBeenCalled());
    expect(await worker.runOnce()).toEqual({ claimed: false });
    expect(h.queue.claim).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("passes the durable Job delivery key to Slack", async () => {
    const postMessage = vi.fn(async () => ({ ts: "3.4" }));
    await slackResultDelivery({ postMessage } as any)({
      idempotencyKey: "job:job-1:result",
      thread: { channel: "C1", ts: "1.2" },
      text: "Done.",
      outcome: "succeeded",
    });
    expect(postMessage).toHaveBeenCalledWith({
      idempotencyKey: "job:job-1:result",
      thread: { channel: "C1", ts: "1.2" },
      text: "Done.",
      format: "markdown",
    });
  });
});
