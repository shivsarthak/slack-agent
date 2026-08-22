import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/hosted/postgres/migrate.ts";
import { createPostgresStores } from "../../src/hosted/postgres/stores.ts";
import { tenantId } from "../../src/tenant.ts";
import { disposablePostgres } from "../support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;

beforeAll(async () => {
  database = await disposablePostgres();
  await migrate(database.pool);
}, 30_000);
afterAll(async () => database.stop());

describe("Tenant-bound PostgreSQL stores", () => {
  it("rejects cross-Tenant repository access and mismatched database identities", async () => {
    const control = createPostgresStores(database.pool);
    const alpha = tenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const beta = tenantId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await control.tenants.create({ id: alpha, name: "Alpha" });
    await control.tenants.create({ id: beta, name: "Beta" });
    await control.users.create({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      email: "owner@example.test",
    });
    const alphaStores = control.forTenant({ id: alpha });
    const betaStores = control.forTenant({ id: beta });
    await alphaStores.jobs.create({
      id: "job-a",
      threadKey: "C1:1",
      request: "alpha work",
    });
    await alphaStores.schedules.create({
      id: "schedule-a",
      creatorUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      task: "alpha schedule",
      destination: { channelId: "C1" },
      timezone: "UTC",
      rule: { kind: "daily" },
      state: "active",
    });
    expect(await betaStores.jobs.get("job-a")).toBeUndefined();
    await expect(
      database.pool.query(
        "insert into occurrences (tenant_id, id, schedule_id, due_at, outcome, manual) values ($1, $2, $3, now(), 'running', false)",
        [beta, "occurrence-x", "schedule-a"],
      ),
    ).rejects.toThrow();
  });

  it("atomically preserves Job and approval invariants", async () => {
    const control = createPostgresStores(database.pool);
    const tenant = { id: tenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc") };
    await control.tenants.create({ id: tenant.id, name: "Atomic" });
    const stores = control.forTenant(tenant);
    await stores.jobs.create({
      id: "job-atomic",
      threadKey: "C2:2",
      request: "deploy",
    });
    const approval = await stores.jobs.requestApproval({
      jobId: "job-atomic",
      approvalId: "approval-1",
      action: "deploy production",
    });
    expect(approval.job.status).toBe("waiting-approval");
    expect(approval.approval.status).toBe("pending");
    const decided = await stores.approvals.decide({
      id: "approval-1",
      decision: "approved",
      decidedBy: "user-1",
    });
    expect(decided.approval.status).toBe("approved");
    expect(decided.job.status).toBe("queued");
    await expect(
      stores.approvals.decide({
        id: "approval-1",
        decision: "denied",
        decidedBy: "user-2",
      }),
    ).rejects.toThrow(/already decided/);
  });
});
