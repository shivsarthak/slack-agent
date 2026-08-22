import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { OperationalMetrics } from "../observability.ts";

export type DurableJobStatus =
  | "queued"
  | "running"
  | "waiting-approval"
  | "succeeded"
  | "failed"
  | "dead-letter"
  | "cancelled";

export interface DurableJob {
  id: string;
  tenantId: string;
  threadKey: string;
  request: string;
  status: DurableJobStatus;
  attempt: number;
  availableAt: Date;
  replayOf?: string;
  cancelledBy?: string;
}

export interface JobLease extends DurableJob {
  status: "running";
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export function createPostgresJobQueue(
  pool: Pool,
  options: {
    now?: () => Date;
    retryBaseMs?: number;
    maxConcurrentJobsPerTenant?: number;
    metrics?: OperationalMetrics;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const maxConcurrentJobsPerTenant = options.maxConcurrentJobsPerTenant;
  if (maxConcurrentJobsPerTenant !== undefined &&
      (!Number.isSafeInteger(maxConcurrentJobsPerTenant) || maxConcurrentJobsPerTenant <= 0))
    throw new Error("Tenant concurrency must be a positive integer");

  return {
    async enqueue(values: {
      tenantId: string;
      id: string;
      threadKey: string;
      request: string;
      idempotencyKey: string;
    }): Promise<DurableJob> {
      if (!values.idempotencyKey)
        throw new Error("An idempotency key is required");
      const result = await pool.query(
        `insert into jobs (tenant_id,id,thread_key,request,idempotency_key,available_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key
         returning *`,
        [
          values.tenantId,
          values.id,
          values.threadKey,
          values.request,
          values.idempotencyKey,
          now(),
        ],
      );
      return record(result.rows[0]!);
    },

    async get(tenantId: string, id: string): Promise<DurableJob | undefined> {
      const result = await pool.query(
        "select * from jobs where tenant_id=$1 and id=$2",
        [tenantId, id],
      );
      return result.rows[0] && record(result.rows[0]);
    },

    async claim(owner: string, leaseMs: number): Promise<JobLease | undefined> {
      if (!owner || leaseMs <= 0)
        throw new Error("A lease owner and positive duration are required");
      return transaction(pool, async (client) => {
        const at = now();
        // Claimers must make the capacity decision from one serialized snapshot. Row
        // locks alone cannot protect an aggregate count when no capacity row exists.
        if (maxConcurrentJobsPerTenant !== undefined)
          await client.query("select pg_advisory_xact_lock(hashtext('open-agent:job-admission'))");
        // A third attempt whose worker disappeared has exhausted the same policy as a
        // reported third failure. Persist that terminal state before looking for work.
        await client.query(
          `update jobs set status='dead-letter', last_error=coalesce(last_error,'lease expired'),
             lease_owner=null, lease_expires_at=null, lease_token=null, updated_at=$1
           where status='running' and lease_expires_at <= $1 and attempt >= 3`,
          [at],
        );
        const token = randomUUID();
        const result = await client.query(
          `with candidate as (
             select tenant_id,id from jobs
             where (status='queued' and available_at <= $1 and not exists (
                    select 1 from jobs active where active.tenant_id=jobs.tenant_id
                      and active.thread_key=jobs.thread_key and active.status='running'
                  ) and ($5::integer is null or (
                    select count(*) from jobs active where active.tenant_id=jobs.tenant_id
                      and active.status='running' and active.lease_expires_at > $1
                  ) < $5))
                or (status='running' and lease_expires_at <= $1 and attempt < 3)
             order by available_at,created_at
             for update skip locked limit 1
           )
           update jobs j set status='running', attempt=j.attempt+1, lease_owner=$2,
             lease_token=$3, lease_expires_at=$4, updated_at=$1
           from candidate c where j.tenant_id=c.tenant_id and j.id=c.id returning j.*`,
          [at, owner, token, new Date(at.getTime() + leaseMs), maxConcurrentJobsPerTenant ?? null],
        );
        if (result.rows[0]) {
          const lease = leaseRecord(result.rows[0]);
          options.metrics?.increment("queue.admitted", {
            tenantId: lease.tenantId, jobId: lease.id, outcome: "admitted",
          });
          return lease;
        }
        if (maxConcurrentJobsPerTenant !== undefined) {
          const denied = await client.query<{ tenant_id: string; id: string }>(
            `select tenant_id,id from jobs queued where status='queued' and available_at <= $1
             and (select count(*) from jobs active where active.tenant_id=queued.tenant_id
               and active.status='running' and active.lease_expires_at > $1) >= $2
             order by available_at,created_at limit 1`,
            [at, maxConcurrentJobsPerTenant],
          );
          if (denied.rows[0]) options.metrics?.increment("queue.denied", {
            tenantId: denied.rows[0].tenant_id, jobId: denied.rows[0].id, outcome: "concurrency",
          });
        }
        return undefined;
      });
    },

    async renew(lease: JobLease, leaseMs: number): Promise<JobLease> {
      if (leaseMs <= 0)
        throw new Error("A positive lease duration is required");
      const at = now();
      const row = await mutateLease(
        pool,
        lease,
        `lease_expires_at=$4, updated_at=$3`,
        [new Date(at.getTime() + leaseMs)],
        at,
      );
      return leaseRecord(row);
    },

    async succeed(lease: JobLease): Promise<DurableJob> {
      return record(
        await mutateLease(
          pool,
          lease,
          `status='succeeded', lease_owner=null, lease_expires_at=null, lease_token=null, updated_at=$3`,
          [],
          now(),
        ),
      );
    },

    async fail(
      lease: JobLease,
      error: string,
      options: { retryable?: boolean } = {},
    ): Promise<DurableJob> {
      const at = now();
      const retryable = options.retryable ?? true;
      const exhausted = lease.attempt >= 3;
      const available = new Date(
        at.getTime() + retryBaseMs * 2 ** (lease.attempt - 1),
      );
      return record(
        await mutateLease(
          pool,
          lease,
          `status=$4, last_error=$5, available_at=$6, lease_owner=null, lease_expires_at=null, lease_token=null, updated_at=$3`,
          [
            exhausted ? "dead-letter" : retryable ? "queued" : "failed",
            error,
            available,
          ],
          at,
        ),
      );
    },

    async cancel(
      tenantId: string,
      id: string,
      actor: string,
      reason: string,
    ): Promise<DurableJob> {
      if (!actor || !reason)
        throw new Error("Cancellation requires an actor and reason");
      return transaction(pool, async (client) => {
        const at = now();
        const result = await client.query(
          `update jobs set status='cancelled', cancelled_by=$3, cancelled_reason=$4, cancelled_at=$5,
             lease_owner=null, lease_expires_at=null, lease_token=null, updated_at=$5
           where tenant_id=$1 and id=$2 and status in ('queued','running','waiting-approval') returning *`,
          [tenantId, id, actor, reason, at],
        );
        if (!result.rows[0]) throw new Error(`Job ${id} cannot be cancelled`);
        await client.query(
          `insert into audit_events(tenant_id,actor_id,event_type,subject_type,subject_id,payload,occurred_at)
           values ($1,$2,'job.cancelled','job',$3,$4,$5)`,
          [tenantId, actor, id, { reason }, at],
        );
        return record(result.rows[0]);
      });
    },

    async replay(
      tenantId: string,
      sourceId: string,
      audit: { actor: string; reason: string },
    ): Promise<DurableJob> {
      if (!audit.actor || !audit.reason)
        throw new Error("Replay requires actor and reason");
      return transaction(pool, async (client) => {
        const source = await client.query(
          "select * from jobs where tenant_id=$1 and id=$2 for update",
          [tenantId, sourceId],
        );
        if (source.rows[0]?.status !== "dead-letter")
          throw new Error(`Job ${sourceId} is not dead-lettered`);
        const id = randomUUID();
        const created = await client.query(
          `insert into jobs (tenant_id,id,thread_key,request,idempotency_key,replay_of,available_at)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [
            tenantId,
            id,
            source.rows[0].thread_key,
            source.rows[0].request,
            `replay:${sourceId}:${id}`,
            sourceId,
            now(),
          ],
        );
        await client.query(
          `insert into audit_events (tenant_id,actor_id,event_type,subject_type,subject_id,payload)
           values ($1,$2,'job.replayed','job',$3,$4)`,
          [
            tenantId,
            audit.actor,
            id,
            { sourceJobId: sourceId, reason: audit.reason },
          ],
        );
        return record(created.rows[0]!);
      });
    },
  };
}

async function mutateLease(
  pool: Pool,
  lease: JobLease,
  set: string,
  extra: unknown[],
  at: Date,
): Promise<QueryResultRow> {
  const params = [
    lease.tenantId,
    lease.id,
    at,
    ...extra,
    lease.leaseOwner,
    lease.leaseToken,
  ];
  const ownerParameter = params.length - 1;
  const tokenParameter = params.length;
  const result = await pool.query(
    `update jobs set ${set} where tenant_id=$1 and id=$2 and status='running'
       and lease_owner=$${ownerParameter} and lease_token=$${tokenParameter}
       and lease_expires_at > $3 returning *`,
    params,
  );
  if (!result.rows[0])
    throw new Error(`Active lease for job ${lease.id} was lost`);
  return result.rows[0];
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

function record(row: QueryResultRow): DurableJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    threadKey: String(row.thread_key),
    request: String(row.request),
    status: row.status as DurableJobStatus,
    attempt: Number(row.attempt),
    availableAt: new Date(row.available_at),
    replayOf: row.replay_of ?? undefined,
    cancelledBy: row.cancelled_by ?? undefined,
  };
}
function leaseRecord(row: QueryResultRow): JobLease {
  return {
    ...record(row),
    status: "running",
    leaseOwner: String(row.lease_owner),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: new Date(row.lease_expires_at),
  };
}
