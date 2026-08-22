import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { nextDueAt } from "../../schedules/calendar.ts";
import {
  timingRuleSchema,
  type CreateSchedule,
  type Occurrence,
  type Schedule,
} from "../../schedules/types.ts";
import type { ClaimedOccurrence } from "../../schedules/store.ts";

type SchedulePatch = Partial<
  Pick<Schedule, "task" | "destination" | "timezone" | "rule">
>;

/** Tenant-bound durable Schedule operations. Every mutation and audit record shares a transaction. */
export function createPostgresScheduleStore(pool: Pool, tenantId: string) {
  const read = async (
    id: string,
    includeDeleted = false,
  ): Promise<Schedule | undefined> => {
    const result = await pool.query(
      `select * from schedules where tenant_id=$1 and id=$2${includeDeleted ? "" : " and state <> 'deleted'"}`,
      [tenantId, id],
    );
    return result.rows[0] && scheduleRecord(result.rows[0]);
  };

  return {
    async list(): Promise<readonly Schedule[]> {
      const result = await pool.query(
        "select * from schedules where tenant_id=$1 and state <> 'deleted' order by created_at,id",
        [tenantId],
      );
      return result.rows.map(scheduleRecord);
    },
    get(id: string) {
      return read(id);
    },

    async create(
      input: CreateSchedule,
      nowMs: number,
      actorId: string,
    ): Promise<Schedule> {
      const rule = timingRuleSchema.parse(input.rule);
      const due = nextDueAt(rule, input.timezone, nowMs);
      if (due === null)
        throw new Error("The Schedule has no future Occurrence");
      const id = `S-${randomUUID()}`;
      return transaction(pool, async (client) => {
        const result = await client.query(
          `insert into schedules (tenant_id,id,creator_user_id,task,destination,timezone,rule,state,next_due_at,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$9) returning *`,
          [
            tenantId,
            id,
            input.creatorUserId,
            input.task,
            input.destination,
            input.timezone,
            rule,
            new Date(due),
            new Date(nowMs),
          ],
        );
        await audit(
          client,
          tenantId,
          actorId,
          "schedule.created",
          id,
          {},
          new Date(nowMs),
        );
        return scheduleRecord(result.rows[0]!);
      });
    },

    async update(
      id: string,
      patch: SchedulePatch,
      nowMs: number,
      actorId: string,
    ): Promise<Schedule> {
      return transaction(pool, async (client) => {
        const current = await lockSchedule(client, tenantId, id);
        const changed = { ...current, ...structuredClone(patch) };
        timingRuleSchema.parse(changed.rule);
        const next =
          current.state === "active"
            ? nextDueAt(changed.rule, changed.timezone, nowMs)
            : null;
        if (current.state === "active" && next === null)
          throw new Error("The updated Schedule has no future Occurrence");
        const result = await client.query(
          `update schedules set task=$3,destination=$4,timezone=$5,rule=$6,next_due_at=$7,updated_at=$8
           where tenant_id=$1 and id=$2 returning *`,
          [
            tenantId,
            id,
            changed.task,
            changed.destination,
            changed.timezone,
            changed.rule,
            next === null ? null : new Date(next),
            new Date(nowMs),
          ],
        );
        await audit(
          client,
          tenantId,
          actorId,
          "schedule.updated",
          id,
          { fields: Object.keys(patch) },
          new Date(nowMs),
        );
        return scheduleRecord(result.rows[0]!);
      });
    },

    pause(id: string, nowMs: number, actorId: string) {
      return changeState(pool, tenantId, id, "paused", nowMs, actorId);
    },
    async resume(
      id: string,
      nowMs: number,
      actorId: string,
    ): Promise<Schedule> {
      return transaction(pool, async (client) => {
        const current = await lockSchedule(client, tenantId, id);
        const due = nextDueAt(current.rule, current.timezone, nowMs);
        if (due === null)
          throw new Error("The Schedule has no future Occurrence");
        const result = await client.query(
          "update schedules set state='active',next_due_at=$3,updated_at=$4 where tenant_id=$1 and id=$2 returning *",
          [tenantId, id, new Date(due), new Date(nowMs)],
        );
        await audit(
          client,
          tenantId,
          actorId,
          "schedule.resumed",
          id,
          {},
          new Date(nowMs),
        );
        return scheduleRecord(result.rows[0]!);
      });
    },
    delete(id: string, nowMs: number, actorId: string) {
      return changeState(pool, tenantId, id, "deleted", nowMs, actorId);
    },

    async claimDue(nowMs: number): Promise<{
      claimed: readonly ClaimedOccurrence[];
      overlaps: readonly Occurrence[];
    }> {
      return transaction(pool, async (client) => {
        const due = await client.query(
          `select * from schedules where tenant_id=$1 and state='active' and next_due_at <= $2
           order by next_due_at,id for update skip locked`,
          [tenantId, new Date(nowMs)],
        );
        const claimed: ClaimedOccurrence[] = [];
        const overlaps: Occurrence[] = [];
        for (const row of due.rows) {
          const schedule = scheduleRecord(row);
          const dueAt = schedule.nextDueAt!;
          const next = nextDueAt(
            schedule.rule,
            schedule.timezone,
            Date.parse(dueAt),
          );
          await client.query(
            "update schedules set next_due_at=$3,updated_at=$4 where tenant_id=$1 and id=$2",
            [
              tenantId,
              schedule.id,
              next === null ? null : new Date(next),
              new Date(nowMs),
            ],
          );
          const active = await client.query(
            `select 1 from occurrences o join jobs j on (j.tenant_id,j.id)=(o.tenant_id,o.job_id)
             where o.tenant_id=$1 and o.schedule_id=$2 and j.status in ('queued','running','waiting-approval') limit 1`,
            [tenantId, schedule.id],
          );
          const occurrenceId = randomUUID();
          if (active.rowCount) {
            const occurrence = await insertSkipped(
              client,
              tenantId,
              occurrenceId,
              schedule.id,
              dueAt,
              nowMs,
              "overlap",
            );
            if (occurrence) overlaps.push(occurrence);
            continue;
          }
          const jobId = randomUUID();
          const previous = await previousSuccess(client, tenantId, schedule.id);
          await client.query(
            `insert into jobs (tenant_id,id,thread_key,request,idempotency_key,available_at,created_at,updated_at)
             values ($1,$2,$3,$4,$5,$6,$6,$6)`,
            [
              tenantId,
              jobId,
              `${schedule.destination.channelId}:scheduled-${occurrenceId}`,
              scheduledRequest(schedule, dueAt, nowMs, previous),
              `schedule:${schedule.id}:${dueAt}`,
              new Date(nowMs),
            ],
          );
          const inserted = await client.query(
            `insert into occurrences (tenant_id,id,schedule_id,job_id,due_at,started_at,outcome,manual,details)
             values ($1,$2,$3,$4,$5,$6,'running',false,'{}') on conflict (tenant_id,schedule_id,due_at) do nothing returning *`,
            [
              tenantId,
              occurrenceId,
              schedule.id,
              jobId,
              new Date(dueAt),
              new Date(nowMs),
            ],
          );
          if (!inserted.rows[0]) {
            await client.query(
              "delete from jobs where tenant_id=$1 and id=$2",
              [tenantId, jobId],
            );
            continue;
          }
          await audit(
            client,
            tenantId,
            null,
            "schedule.occurrence-enqueued",
            schedule.id,
            { occurrenceId, jobId, dueAt },
            new Date(nowMs),
          );
          claimed.push({
            schedule,
            occurrence: occurrenceRecord(inserted.rows[0]),
            previousSuccessAt: previous,
          });
        }
        return { claimed, overlaps };
      });
    },

    async runNow(
      id: string,
      nowMs: number,
      actorId: string,
    ): Promise<ClaimedOccurrence | { overlap: true; occurrence: Occurrence }> {
      return transaction(pool, async (client) => {
        const schedule = await lockSchedule(client, tenantId, id);
        const active = await client.query(
          `select 1 from occurrences o join jobs j on (j.tenant_id,j.id)=(o.tenant_id,o.job_id)
           where o.tenant_id=$1 and o.schedule_id=$2 and j.status in ('queued','running','waiting-approval') limit 1`,
          [tenantId, schedule.id],
        );
        const dueAt = new Date(nowMs).toISOString();
        const occurrenceId = randomUUID();
        if (active.rowCount) {
          const occurrence = (await insertSkipped(
            client,
            tenantId,
            occurrenceId,
            schedule.id,
            dueAt,
            nowMs,
            "overlap",
            true,
          ))!;
          await audit(
            client,
            tenantId,
            actorId,
            "schedule.run-now-overlap",
            schedule.id,
            { occurrenceId },
            new Date(nowMs),
          );
          return { overlap: true as const, occurrence };
        }
        const jobId = randomUUID();
        const previous = await previousSuccess(client, tenantId, schedule.id);
        await client.query(
          `insert into jobs (tenant_id,id,thread_key,request,idempotency_key,available_at,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$6,$6)`,
          [
            tenantId,
            jobId,
            `${schedule.destination.channelId}:scheduled-${occurrenceId}`,
            scheduledRequest(schedule, dueAt, nowMs, previous),
            `schedule:${schedule.id}:manual:${occurrenceId}`,
            new Date(nowMs),
          ],
        );
        const inserted = await client.query(
          `insert into occurrences (tenant_id,id,schedule_id,job_id,due_at,started_at,outcome,manual,details)
           values ($1,$2,$3,$4,$5,$6,'running',true,'{}') returning *`,
          [
            tenantId,
            occurrenceId,
            schedule.id,
            jobId,
            new Date(dueAt),
            new Date(nowMs),
          ],
        );
        await audit(
          client,
          tenantId,
          actorId,
          "schedule.run-now",
          schedule.id,
          { occurrenceId, jobId },
          new Date(nowMs),
        );
        return {
          schedule,
          occurrence: occurrenceRecord(inserted.rows[0]!),
          previousSuccessAt: previous,
        };
      });
    },

    async reconcileMissed(nowMs: number): Promise<{ missed: number }> {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `select * from schedules where tenant_id=$1 and state='active' and next_due_at < $2
           order by next_due_at,id for update skip locked`,
          [tenantId, new Date(nowMs)],
        );
        let missed = 0;
        for (const row of result.rows) {
          const schedule = scheduleRecord(row);
          const occurrence = await insertSkipped(
            client,
            tenantId,
            randomUUID(),
            schedule.id,
            schedule.nextDueAt!,
            nowMs,
            "offline",
          );
          const next = nextDueAt(schedule.rule, schedule.timezone, nowMs);
          await client.query(
            "update schedules set next_due_at=$3,updated_at=$4 where tenant_id=$1 and id=$2",
            [
              tenantId,
              schedule.id,
              next === null ? null : new Date(next),
              new Date(nowMs),
            ],
          );
          if (occurrence) {
            missed++;
            await audit(
              client,
              tenantId,
              null,
              "schedule.missed",
              schedule.id,
              { dueAt: schedule.nextDueAt },
              new Date(nowMs),
            );
          }
        }
        return { missed };
      });
    },

    async occurrencesFor(scheduleId: string): Promise<readonly Occurrence[]> {
      const result = await pool.query(
        "select * from occurrences where tenant_id=$1 and schedule_id=$2 order by due_at",
        [tenantId, scheduleId],
      );
      return result.rows.map(occurrenceRecord);
    },
    async nextDue(): Promise<number | null> {
      const result = await pool.query(
        "select min(next_due_at) as due from schedules where tenant_id=$1 and state='active'",
        [tenantId],
      );
      return result.rows[0]?.due
        ? new Date(result.rows[0].due).getTime()
        : null;
    },
  };
}

async function changeState(
  pool: Pool,
  tenantId: string,
  id: string,
  state: "paused" | "deleted",
  nowMs: number,
  actorId: string,
): Promise<Schedule> {
  return transaction(pool, async (client) => {
    await lockSchedule(client, tenantId, id);
    const result = await client.query(
      "update schedules set state=$3,next_due_at=null,updated_at=$4 where tenant_id=$1 and id=$2 returning *",
      [tenantId, id, state, new Date(nowMs)],
    );
    await audit(
      client,
      tenantId,
      actorId,
      `schedule.${state}`,
      id,
      {},
      new Date(nowMs),
    );
    return scheduleRecord(result.rows[0]!);
  });
}

async function lockSchedule(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Schedule> {
  const result = await client.query(
    "select * from schedules where tenant_id=$1 and id=$2 and state <> 'deleted' for update",
    [tenantId, id],
  );
  if (!result.rows[0]) throw new Error(`Unknown Schedule ${id}`);
  return scheduleRecord(result.rows[0]);
}

async function insertSkipped(
  client: PoolClient,
  tenantId: string,
  id: string,
  scheduleId: string,
  dueAt: string,
  nowMs: number,
  reason: "offline" | "overlap",
  manual = false,
): Promise<Occurrence | undefined> {
  const result = await client.query(
    `insert into occurrences (tenant_id,id,schedule_id,due_at,finished_at,outcome,manual,details)
     values ($1,$2,$3,$4,$5,'skipped',$6,$7) on conflict (tenant_id,schedule_id,due_at) do nothing returning *`,
    [
      tenantId,
      id,
      scheduleId,
      new Date(dueAt),
      new Date(nowMs),
      manual,
      { skipReason: reason },
    ],
  );
  return result.rows[0] && occurrenceRecord(result.rows[0]);
}

async function previousSuccess(
  client: PoolClient,
  tenantId: string,
  scheduleId: string,
): Promise<string | null> {
  const result = await client.query(
    "select max(due_at) as due from occurrences where tenant_id=$1 and schedule_id=$2 and outcome='succeeded'",
    [tenantId, scheduleId],
  );
  return result.rows[0]?.due
    ? new Date(result.rows[0].due).toISOString()
    : null;
}

function scheduledRequest(
  schedule: Schedule,
  dueAt: string,
  nowMs: number,
  previous: string | null,
): string {
  return `${schedule.task}\n\nTrusted Schedule context:\nSchedule: ${schedule.id}\nScheduled due time: ${dueAt}\nActual start time: ${new Date(nowMs).toISOString()}\nTimezone: ${schedule.timezone}\nPrevious successful Occurrence: ${previous ?? "none"}`;
}

async function audit(
  client: PoolClient,
  tenantId: string,
  actorId: string | null,
  eventType: string,
  subjectId: string,
  payload: object,
  at: Date,
): Promise<void> {
  await client.query(
    "insert into audit_events (tenant_id,actor_id,event_type,subject_type,subject_id,payload,occurred_at) values ($1,$2,$3,'schedule',$4,$5,$6)",
    [tenantId, actorId, eventType, subjectId, payload, at],
  );
}

function scheduleRecord(row: QueryResultRow): Schedule {
  return {
    id: String(row.id),
    creatorUserId: String(row.creator_user_id),
    task: String(row.task),
    destination: row.destination as Schedule["destination"],
    timezone: String(row.timezone),
    rule: timingRuleSchema.parse(row.rule),
    state: row.state as Schedule["state"],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    nextDueAt: row.next_due_at ? new Date(row.next_due_at).toISOString() : null,
  };
}

function occurrenceRecord(row: QueryResultRow): Occurrence {
  const details = (row.details ?? {}) as {
    skipReason?: Occurrence["skipReason"];
    failureReason?: string;
    threadTs?: string;
  };
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    dueAt: new Date(row.due_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : null,
    outcome: row.outcome as Occurrence["outcome"],
    manual: Boolean(row.manual),
    ...(details.skipReason ? { skipReason: details.skipReason } : {}),
    ...(details.failureReason ? { failureReason: details.failureReason } : {}),
    ...(details.threadTs ? { threadTs: details.threadTs } : {}),
  };
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
