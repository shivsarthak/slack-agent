import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresJobQueue } from "../src/hosted/postgres/job-queue.ts";
import { migrate } from "../src/hosted/postgres/migrate.ts";
import { disposablePostgres } from "./support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;
let pool: Pool;
let tenantId: string;

beforeAll(async () => {
  database = await disposablePostgres();
  pool = database.pool;
  await migrate(pool);
  tenantId = randomUUID();
  await pool.query(
    "insert into tenants (id, name) values ($1, 'Queue tests')",
    [tenantId],
  );
}, 30_000);
afterAll(async () => database.stop());

describe("durable PostgreSQL job queue", () => {
  it("atomically enforces the configured per-Tenant concurrency quota", async () => {
    const queue = createPostgresJobQueue(pool, { maxConcurrentJobsPerTenant: 1 });
    await Promise.all([
      queue.enqueue({ tenantId, id: "quota-a", threadKey: "quota:a", request: "a", idempotencyKey: "quota-a" }),
      queue.enqueue({ tenantId, id: "quota-b", threadKey: "quota:b", request: "b", idempotencyKey: "quota-b" }),
    ]);

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) => queue.claim(`quota-worker-${index}`, 30_000)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await queue.succeed(claims.find(Boolean)!);
    expect(await queue.claim("quota-worker-next", 30_000)).toBeDefined();
  });

  it("enqueues idempotently and gives concurrent claimers different jobs", async () => {
    const queue = createPostgresJobQueue(pool);
    const first = await queue.enqueue({
      tenantId,
      id: "claim-a",
      threadKey: "c:t",
      request: "a",
      idempotencyKey: "slack:event-a",
    });
    expect(
      (
        await queue.enqueue({
          tenantId,
          id: "ignored",
          threadKey: "c:t",
          request: "a",
          idempotencyKey: "slack:event-a",
        })
      ).id,
    ).toBe(first.id);
    await queue.enqueue({
      tenantId,
      id: "claim-b",
      threadKey: "c:u",
      request: "b",
      idempotencyKey: "slack:event-b",
    });
    const [a, b] = await Promise.all([
      queue.claim("worker-a", 30_000),
      queue.claim("worker-b", 30_000),
    ]);
    expect(new Set([a?.id, b?.id])).toEqual(new Set(["claim-a", "claim-b"]));
    expect(a?.leaseToken).not.toBe(b?.leaseToken);
  });

  it("keeps jobs in one Thread sequential across workers", async () => {
    const queue = createPostgresJobQueue(pool);
    await queue.enqueue({
      tenantId,
      id: "thread-a",
      threadKey: "c:same",
      request: "a",
      idempotencyKey: "thread-a",
    });
    await queue.enqueue({
      tenantId,
      id: "thread-b",
      threadKey: "c:same",
      request: "b",
      idempotencyKey: "thread-b",
    });
    const first = (await queue.claim("worker-a", 30_000))!;
    expect(first.id).toBe("thread-a");
    expect(await queue.claim("worker-b", 30_000)).toBeUndefined();
    await queue.succeed(first);
    expect((await queue.claim("worker-b", 30_000))?.id).toBe("thread-b");
  });

  it("recovers expired leases and rejects the stale owner", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const queue = createPostgresJobQueue(pool, { now: () => now });
    await queue.enqueue({
      tenantId,
      id: "recover",
      threadKey: "c:r",
      request: "recover",
      idempotencyKey: "recover",
    });
    const stale = await queue.claim("crashed", 1_000);
    now = new Date(now.getTime() + 1_001);
    const recovered = await queue.claim("replacement", 1_000);
    expect(recovered?.id).toBe("recover");
    expect(recovered?.attempt).toBe(2);
    await expect(queue.succeed(stale!)).rejects.toThrow(/lease/i);
    await queue.succeed(recovered!);
  });

  it("renews leases and retries twice with exponential backoff before dead-lettering", async () => {
    let now = new Date("2026-02-01T00:00:00Z");
    const queue = createPostgresJobQueue(pool, {
      now: () => now,
      retryBaseMs: 1_000,
    });
    await queue.enqueue({
      tenantId,
      id: "retry",
      threadKey: "c:x",
      request: "retry",
      idempotencyKey: "retry",
    });
    let lease = (await queue.claim("worker", 500))!;
    now = new Date(now.getTime() + 400);
    lease = await queue.renew(lease, 1_000);
    expect(lease.leaseExpiresAt.getTime()).toBe(now.getTime() + 1_000);
    let failed = await queue.fail(lease, "first");
    expect(failed.status).toBe("queued");
    expect(failed.availableAt.getTime()).toBe(now.getTime() + 1_000);
    expect(await queue.claim("worker", 500)).toBeUndefined();
    now = failed.availableAt;
    lease = (await queue.claim("worker", 500))!;
    failed = await queue.fail(lease, "second");
    expect(failed.availableAt.getTime()).toBe(now.getTime() + 2_000);
    now = failed.availableAt;
    lease = (await queue.claim("worker", 500))!;
    failed = await queue.fail(lease, "third");
    expect(failed.status).toBe("dead-letter");
    expect(failed.attempt).toBe(3);
  });

  it("records a classified terminal failure without retrying", async () => {
    const queue = createPostgresJobQueue(pool);
    await queue.enqueue({
      tenantId,
      id: "terminal",
      threadKey: "c:terminal",
      request: "invalid configuration",
      idempotencyKey: "terminal",
    });
    const claimed = (await queue.claim("worker", 30_000))!;
    const failed = await queue.fail(claimed, "invalid Tenant configuration", {
      retryable: false,
    });
    expect(failed.status).toBe("failed");
    expect(await queue.claim("another-worker", 30_000)).toBeUndefined();
  });

  it("cancels work durably and makes dead-letter replay auditable", async () => {
    const queue = createPostgresJobQueue(pool);
    await queue.enqueue({
      tenantId,
      id: "cancel",
      threadKey: "c:c",
      request: "cancel",
      idempotencyKey: "cancel",
    });
    expect(
      (await queue.cancel(tenantId, "cancel", "operator", "no longer needed"))
        .status,
    ).toBe("cancelled");
    const cancelled = await queue.get(tenantId, "cancel");
    expect(cancelled?.cancelledBy).toBe("operator");
    const cancellationAudit = await pool.query(
      "select actor_id,payload from audit_events where tenant_id=$1 and event_type='job.cancelled' and subject_id='cancel'",
      [tenantId],
    );
    expect(cancellationAudit.rows).toEqual([
      { actor_id: "operator", payload: { reason: "no longer needed" } },
    ]);

    await pool.query(
      "insert into jobs (tenant_id,id,thread_key,request,status,attempt,idempotency_key,last_error) values ($1,'dead','c:d','dead','dead-letter',3,'dead','boom')",
      [tenantId],
    );
    await expect(
      queue.replay(tenantId, "dead", { actor: "", reason: "" }),
    ).rejects.toThrow(/actor.*reason/i);
    const replay = await queue.replay(tenantId, "dead", {
      actor: "operator",
      reason: "dependency repaired",
    });
    expect(replay.replayOf).toBe("dead");
    const audit = await pool.query(
      "select actor_id, payload from audit_events where tenant_id=$1 and event_type='job.replayed' and subject_id=$2",
      [tenantId, replay.id],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_id: "operator",
      payload: { sourceJobId: "dead", reason: "dependency repaired" },
    });
  });
});
