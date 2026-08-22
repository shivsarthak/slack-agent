import type { Pool, PoolClient } from "pg";

export interface QuotaAdmissionRequest {
  tenantId: string;
  jobId: string;
  quota: string;
  amount: number;
}

export type QuotaAdmission =
  | { admitted: true; used: number; limit: number }
  | { admitted: false; reason: "quota-exceeded" | "quota-unconfigured"; used: number; limit: number };

/** Atomic, Tenant-scoped admission. A denial and its audit event share the transaction. */
export function createPostgresQuotaAdmission(pool: Pool, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async consume(request: QuotaAdmissionRequest): Promise<QuotaAdmission> {
      if (!request.tenantId || !request.jobId || !request.quota ||
          !Number.isSafeInteger(request.amount) || request.amount <= 0)
        throw new Error("Quota admission requires Tenant, Job, quota, and a positive integer amount");
      const client = await pool.connect();
      try {
        await client.query("begin");
        const at = now();
        const consumed = await client.query<{ used_value: string; limit_value: string }>(
          `update quotas set used_value=used_value+$4
           where tenant_id=$1 and id=$2 and period_starts_at <= $3 and period_ends_at > $3
             and used_value+$4 <= limit_value
           returning used_value,limit_value`,
          [request.tenantId, request.quota, at, request.amount],
        );
        if (consumed.rows[0]) {
          await client.query("commit");
          return { admitted: true, used: Number(consumed.rows[0].used_value), limit: Number(consumed.rows[0].limit_value) };
        }
        const configured = await client.query<{ used_value: string; limit_value: string }>(
          `select used_value,limit_value from quotas
           where tenant_id=$1 and id=$2 and period_starts_at <= $3 and period_ends_at > $3 for update`,
          [request.tenantId, request.quota, at],
        );
        const reason = configured.rows[0] ? "quota-exceeded" : "quota-unconfigured";
        const used = Number(configured.rows[0]?.used_value ?? 0);
        const limit = Number(configured.rows[0]?.limit_value ?? 0);
        await auditDenied(client, request, reason, used, limit, at);
        await client.query("commit");
        return { admitted: false, reason, used, limit };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function auditDenied(
  client: PoolClient,
  request: QuotaAdmissionRequest,
  reason: string,
  used: number,
  limit: number,
  at: Date,
): Promise<void> {
  await client.query(
    `insert into audit_events(tenant_id,actor_id,event_type,subject_type,subject_id,payload,occurred_at)
     values ($1,'system','quota.denied','job',$2,$3,$4)`,
    [request.tenantId, request.jobId, { quota: request.quota, amount: request.amount, reason, used, limit }, at],
  );
}
