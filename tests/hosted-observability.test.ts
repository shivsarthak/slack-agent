import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createHealthHandler,
  createInMemoryMetrics,
  createStructuredTelemetry,
} from "../src/hosted/observability.ts";
import { createPostgresQuotaAdmission } from "../src/hosted/postgres/quota-admission.ts";
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
  await pool.query("insert into tenants(id,name) values ($1,'Observability')", [tenantId]);
}, 30_000);
afterAll(async () => database.stop());

describe("hosted quota admission and observability", () => {
  it("cannot overspend a usage quota under concurrent admission and audits denials", async () => {
    const now = new Date("2026-08-23T00:00:00Z");
    await pool.query(
      "insert into quotas(tenant_id,id,limit_value,period_starts_at,period_ends_at) values ($1,'tokens',10,$2,$3)",
      [tenantId, now, new Date("2026-08-24T00:00:00Z")],
    );
    const admission = createPostgresQuotaAdmission(pool, { now: () => now });
    const results = await Promise.all(
      [6, 6].map((amount, index) => admission.consume({ tenantId, jobId: `usage-${index}`, quota: "tokens", amount })),
    );
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect(results.find((result) => !result.admitted)).toMatchObject({ reason: "quota-exceeded", limit: 10 });
    const used = await pool.query("select used_value from quotas where tenant_id=$1 and id='tokens'", [tenantId]);
    expect(Number(used.rows[0].used_value)).toBe(6);
    const audit = await pool.query("select actor_id,event_type,subject_id,payload from audit_events where tenant_id=$1 and event_type='quota.denied'", [tenantId]);
    expect(audit.rows).toEqual([expect.objectContaining({ actor_id: "system", subject_id: expect.stringMatching(/^usage-/), payload: expect.objectContaining({ quota: "tokens" }) })]);
  });

  it("makes audit evidence append-only", async () => {
    const event = await pool.query(
      "insert into audit_events(tenant_id,actor_id,event_type,subject_type,subject_id) values ($1,'operator','credential.rotated','credential','github') returning id",
      [tenantId],
    );
    await expect(pool.query("delete from audit_events where tenant_id=$1 and id=$2", [tenantId, event.rows[0].id]))
      .rejects.toThrow(/immutable/i);
  });

  it("redacts nested credentials and content while preserving Tenant/Job correlation", () => {
    const entries: unknown[] = [];
    const telemetry = createStructuredTelemetry((entry) => entries.push(entry));
    telemetry.emit("tool.denied", {
      tenantId,
      jobId: "job-17",
      outcome: "denied",
      details: { authorization: "Bearer plaintext", token: "secret", prompt: "private content", safe: "github/create_issue" },
    });
    expect(entries).toEqual([expect.objectContaining({ event: "tool.denied", tenantId, jobId: "job-17", details: { authorization: "[REDACTED]", token: "[REDACTED]", prompt: "[REDACTED]", safe: "github/create_issue" } })]);
    expect(JSON.stringify(entries)).not.toMatch(/plaintext|private content|secret/);
  });

  it("records vendor-neutral queue, lease, retry, dead-letter, session, and tool outcomes", () => {
    const metrics = createInMemoryMetrics();
    for (const name of ["queue.admitted", "lease.claimed", "job.retry", "job.dead-letter", "session.resumed", "tool.denied"] as const)
      metrics.increment(name, { tenantId, jobId: "job-17", outcome: "ok" });
    expect(metrics.snapshot().map((metric) => metric.name)).toEqual([
      "queue.admitted", "lease.claimed", "job.retry", "job.dead-letter", "session.resumed", "tool.denied",
    ]);
  });

  it("keeps liveness independent and reports dependency readiness without leaking errors", async () => {
    const handler = createHealthHandler({ readiness: vi.fn().mockRejectedValue(new Error("postgres://user:password@host/database")) });
    expect(await (await handler(new Request("http://local/health"))).json()).toEqual({ status: "ok" });
    const response = await handler(new Request("http://local/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready" });
  });
});
