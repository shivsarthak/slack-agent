import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../src/hosted/postgres/migrate.ts";
import { createTenantOperationsHttpHandler } from "../src/dashboard/operations.ts";
import { disposablePostgres } from "./support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;
let pool: Pool;
const alpha = "81000000-0000-4000-8000-000000000001";
const beta = "81000000-0000-4000-8000-000000000002";
const owner = "82000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  database = await disposablePostgres();
  pool = database.pool;
  await migrate(pool);
  await pool.query("insert into users(id,email) values ($1,'operator@example.com')", [owner]);
  await pool.query("insert into tenants(id,name) values ($1,'Alpha'),($2,'Beta')", [alpha, beta]);
  await pool.query("insert into memberships(tenant_id,user_id,role) values ($1,$3,'owner'),($2,$3,'owner')", [alpha, beta, owner]);
  await pool.query(`insert into jobs(tenant_id,id,thread_key,request,status,attempt,idempotency_key,last_error)
    values ($1,'alpha-job','c:a','alpha request','dead-letter',3,'alpha-job','sensitive failure'),
           ($2,'beta-job','c:b','beta request','dead-letter',3,'beta-job','other failure')`, [alpha, beta]);
  await pool.query("insert into approvals(tenant_id,id,job_id,action) values ($1,'approval-1','alpha-job','publish report')", [alpha]);
  await pool.query("insert into credentials(tenant_id,id,kind,encrypted_value,key_version) values ($1,'openai','openai','ciphertext-never-render',1)", [alpha]);
});
afterAll(async () => database.stop());

function handler(role: "owner" | "admin" | "member" = "owner") {
  return createTenantOperationsHttpHandler({
    pool,
    authorize: async (_request, tenantId, allowed) =>
      allowed.includes(role) ? { userId: owner, tenantId, role } : undefined,
    now: () => new Date("2026-08-23T12:00:00Z"),
  });
}

describe("Tenant operations dashboard HTTP seam", () => {
  it("returns only the selected Tenant's operational data and never secret values", async () => {
    const response = await handler()(new Request(`http://dashboard.test/api/operations/jobs?tenantId=${alpha}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("alpha-job");
    expect(text).not.toContain("beta-job");

    const integrations = await handler()(new Request(`http://dashboard.test/api/operations/integrations?tenantId=${alpha}`));
    const integrationText = await integrations.text();
    expect(integrationText).toContain('"openai":"connected"');
    expect(integrationText).not.toContain("ciphertext-never-render");
  });

  it("enforces role-aware mutations", async () => {
    const response = await handler("member")(new Request(`http://dashboard.test/api/operations/approvals/approval-1?tenantId=${alpha}`, {
      method: "POST", body: JSON.stringify({ decision: "approved", idempotencyKey: "decision-1" }),
    }));
    expect(response.status).toBe(403);
  });

  it("makes approval decisions auditable and idempotent", async () => {
    const request = () => new Request(`http://dashboard.test/api/operations/approvals/approval-1?tenantId=${alpha}`, {
      method: "POST", body: JSON.stringify({ decision: "approved", idempotencyKey: "decision-1" }),
    });
    const first = await handler()(request());
    const second = await handler()(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "approved", idempotent: true });
    const audit = await pool.query("select * from audit_events where tenant_id=$1 and event_type='approval.decided'", [alpha]);
    expect(audit.rows).toHaveLength(1);
  });

  it("replays dead letters once per idempotency key and audits the action", async () => {
    const request = () => new Request(`http://dashboard.test/api/operations/dead-letters/alpha-job/replay?tenantId=${alpha}`, {
      method: "POST", body: JSON.stringify({ reason: "operator retry", idempotencyKey: "replay-1" }),
    });
    const first = await (await handler()(request())).json() as { job: { id: string } };
    const second = await (await handler()(request())).json() as { job: { id: string }, idempotent: boolean };
    expect(second.job.id).toBe(first.job.id);
    expect(second.idempotent).toBe(true);
    const replayed = await pool.query("select * from jobs where tenant_id=$1 and replay_of='alpha-job'", [alpha]);
    expect(replayed.rows).toHaveLength(1);
    const audit = await pool.query("select * from audit_events where tenant_id=$1 and event_type='job.replayed'", [alpha]);
    expect(audit.rows).toHaveLength(1);
  });

  it("serializes concurrent replay requests with the same idempotency key", async () => {
    await pool.query(`insert into jobs(tenant_id,id,thread_key,request,status,attempt,idempotency_key)
      values ($1,'concurrent-dead','c:c','retry me','dead-letter',3,'concurrent-dead')`, [alpha]);
    const request = () => new Request(`http://dashboard.test/api/operations/dead-letters/concurrent-dead/replay?tenantId=${alpha}`, {
      method: "POST", body: JSON.stringify({ reason: "concurrent retry", idempotencyKey: "same-key" }),
    });
    const responses = await Promise.all([handler()(request()), handler()(request())]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as { job: { id: string } }[];
    expect(bodies[0]!.job.id).toBe(bodies[1]!.job.id);
    const replayed = await pool.query("select 1 from jobs where tenant_id=$1 and replay_of='concurrent-dead'", [alpha]);
    expect(replayed.rows).toHaveLength(1);
  });
});
