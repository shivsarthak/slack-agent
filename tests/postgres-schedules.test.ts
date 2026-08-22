import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresScheduleStore } from "../src/hosted/postgres/schedules.ts";
import { createPostgresJobQueue } from "../src/hosted/postgres/job-queue.ts";
import { migrate } from "../src/hosted/postgres/migrate.ts";
import { disposablePostgres } from "./support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;
let pool: Pool;
let tenantId: string;
let creatorUserId: string;

beforeAll(async () => {
  database = await disposablePostgres();
  pool = database.pool;
  await migrate(pool);
  tenantId = randomUUID();
  creatorUserId = randomUUID();
  await pool.query("insert into users (id,email) values ($1,$2)", [
    creatorUserId,
    `${creatorUserId}@test.invalid`,
  ]);
  await pool.query("insert into tenants (id,name) values ($1,'Schedules')", [
    tenantId,
  ]);
}, 30_000);
afterAll(async () => database.stop());

describe("hosted PostgreSQL schedules", () => {
  it("claims a due slot once across concurrent schedulers and enqueues an ordinary Job", async () => {
    const due = new Date("2026-06-01T09:00:00Z");
    const store = createPostgresScheduleStore(pool, tenantId);
    const schedule = await store.create(
      {
        creatorUserId,
        task: "Summarize incidents",
        destination: { channelId: "C_OPS", channelName: "ops" },
        timezone: "UTC",
        rule: { kind: "once", at: due.toISOString() },
      },
      due.getTime() - 1_000,
      creatorUserId,
    );

    const [first, second] = await Promise.all([
      store.claimDue(due.getTime()),
      store.claimDue(due.getTime()),
    ]);
    expect(first.claimed.length + second.claimed.length).toBe(1);
    const occurrence = [...first.claimed, ...second.claimed][0]!;
    expect(occurrence.schedule.id).toBe(schedule.id);

    const rows = await pool.query(
      `select o.schedule_id,o.due_at,o.job_id,j.request,j.thread_key,j.status
       from occurrences o join jobs j on (j.tenant_id,j.id)=(o.tenant_id,o.job_id)
       where o.tenant_id=$1 and o.schedule_id=$2`,
      [tenantId, schedule.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      schedule_id: schedule.id,
      status: "queued",
    });
    expect(rows.rows[0].request).toContain("Summarize incidents");
    expect(rows.rows[0].request).toContain(`Schedule: ${schedule.id}`);
    expect(rows.rows[0].thread_key).toMatch(/^C_OPS:/);
    const lease = await createPostgresJobQueue(pool, { now: () => due }).claim(
      "hosted-worker",
      30_000,
    );
    expect(lease).toMatchObject({
      id: rows.rows[0].job_id,
      tenantId,
      status: "running",
    });
  });

  it("does not duplicate after restart and preserves missed, disabled, deleted, and audit behavior", async () => {
    const now = new Date("2026-07-02T10:00:00Z");
    const first = createPostgresScheduleStore(pool, tenantId);
    const schedule = await first.create(
      {
        creatorUserId,
        task: "Daily digest",
        destination: { channelId: "C_DAILY", channelName: "daily" },
        timezone: "Asia/Kolkata",
        rule: { kind: "daily", time: { hour: 9, minute: 0 } },
      },
      new Date("2026-07-01T00:00:00Z").getTime(),
      creatorUserId,
    );

    expect((await first.reconcileMissed(now.getTime())).missed).toBe(1);
    const restarted = createPostgresScheduleStore(pool, tenantId);
    expect((await restarted.claimDue(now.getTime())).claimed).toHaveLength(0);
    await restarted.pause(schedule.id, now.getTime(), creatorUserId);
    expect(
      (await restarted.claimDue(now.getTime() + 86_400_000)).claimed,
    ).toHaveLength(0);
    await restarted.resume(schedule.id, now.getTime(), creatorUserId);
    await restarted.delete(schedule.id, now.getTime(), creatorUserId);
    expect(await restarted.get(schedule.id)).toBeUndefined();

    const occurrences = await restarted.occurrencesFor(schedule.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "offline",
    });
    const audit = await pool.query(
      "select event_type from audit_events where tenant_id=$1 and subject_id=$2 order by id",
      [tenantId, schedule.id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "schedule.created",
      "schedule.missed",
      "schedule.paused",
      "schedule.resumed",
      "schedule.deleted",
    ]);
  });

  it("runs now through the hosted Job queue without moving the calendar slot", async () => {
    const now = new Date("2026-08-01T08:00:00Z");
    const store = createPostgresScheduleStore(pool, tenantId);
    const schedule = await store.create(
      {
        creatorUserId,
        task: "Prepare the report",
        destination: { channelId: "C_REPORT", channelName: "report" },
        timezone: "UTC",
        rule: { kind: "daily", time: { hour: 12, minute: 0 } },
      },
      now.getTime(),
      creatorUserId,
    );
    const result = await store.runNow(
      schedule.id,
      now.getTime(),
      creatorUserId,
    );
    expect(result).not.toHaveProperty("overlap");
    expect("occurrence" in result && result.occurrence.manual).toBe(true);
    expect((await store.get(schedule.id))?.nextDueAt).toBe(schedule.nextDueAt);
    const job = await pool.query(
      "select status from jobs where tenant_id=$1 and id=(select job_id from occurrences where tenant_id=$1 and schedule_id=$2 and manual)",
      [tenantId, schedule.id],
    );
    expect(job.rows[0]?.status).toBe("queued");
  });
});
