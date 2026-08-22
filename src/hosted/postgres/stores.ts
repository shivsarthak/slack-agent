import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Tenant, TenantId } from "../../tenant.ts";

type JobStatus =
  | "queued"
  | "running"
  | "waiting-approval"
  | "succeeded"
  | "failed"
  | "dead-letter";
type ApprovalStatus = "pending" | "approved" | "denied" | "inactive";

export interface JobRecord {
  readonly [key: string]: unknown;
  id: string;
  threadKey: string;
  request: string;
  status: JobStatus;
  attempt: number;
}
export interface ApprovalRecord {
  readonly [key: string]: unknown;
  id: string;
  jobId: string;
  action: string;
  status: ApprovalStatus;
  decidedBy?: string;
}

export interface TenantEntityRepository {
  create(
    values: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  get(id: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  list(): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export interface TenantStores {
  memberships: TenantEntityRepository;
  slackInstallations: TenantEntityRepository;
  credentials: TenantEntityRepository;
  sessions: TenantEntityRepository;
  schedules: TenantEntityRepository;
  occurrences: TenantEntityRepository;
  quotas: TenantEntityRepository;
  auditEvents: TenantEntityRepository;
  jobs: {
    create(values: {
      id: string;
      threadKey: string;
      request: string;
    }): Promise<JobRecord>;
    get(id: string): Promise<JobRecord | undefined>;
    requestApproval(values: {
      jobId: string;
      approvalId: string;
      action: string;
    }): Promise<{ job: JobRecord; approval: ApprovalRecord }>;
    list(): Promise<readonly Readonly<Record<string, unknown>>[]>;
  };
  approvals: {
    get(id: string): Promise<ApprovalRecord | undefined>;
    decide(values: {
      id: string;
      decision: "approved" | "denied";
      decidedBy: string;
    }): Promise<{ job: JobRecord; approval: ApprovalRecord }>;
    list(): Promise<readonly Readonly<Record<string, unknown>>[]>;
  };
}

const entityDefinitions = {
  memberships: {
    table: "memberships",
    key: "user_id",
    columns: { userId: "user_id", role: "role" },
  },
  slackInstallations: {
    table: "slack_installations",
    key: "id",
    columns: {
      id: "id",
      slackTeamId: "slack_team_id",
      enterpriseId: "enterprise_id",
      botUserId: "bot_user_id",
      encryptedBotToken: "encrypted_bot_token",
      installedByUserId: "installed_by_user_id",
    },
  },
  credentials: {
    table: "credentials",
    key: "id",
    columns: {
      id: "id",
      kind: "kind",
      encryptedValue: "encrypted_value",
      keyVersion: "key_version",
      expiresAt: "expires_at",
      revokedAt: "revoked_at",
    },
  },
  sessions: {
    table: "sessions",
    key: "id",
    columns: {
      id: "id",
      threadKey: "thread_key",
      engine: "engine",
      engineSessionId: "engine_session_id",
      locator: "locator",
      interrupted: "interrupted",
    },
  },
  schedules: {
    table: "schedules",
    key: "id",
    columns: {
      id: "id",
      creatorUserId: "creator_user_id",
      task: "task",
      destination: "destination",
      timezone: "timezone",
      rule: "rule",
      state: "state",
      nextDueAt: "next_due_at",
    },
  },
  occurrences: {
    table: "occurrences",
    key: "id",
    columns: {
      id: "id",
      scheduleId: "schedule_id",
      jobId: "job_id",
      dueAt: "due_at",
      startedAt: "started_at",
      finishedAt: "finished_at",
      outcome: "outcome",
      manual: "manual",
      details: "details",
    },
  },
  quotas: {
    table: "quotas",
    key: "id",
    columns: {
      id: "id",
      limitValue: "limit_value",
      usedValue: "used_value",
      periodStartsAt: "period_starts_at",
      periodEndsAt: "period_ends_at",
    },
  },
  auditEvents: {
    table: "audit_events",
    key: "id",
    columns: {
      actorId: "actor_id",
      eventType: "event_type",
      subjectType: "subject_type",
      subjectId: "subject_id",
      payload: "payload",
      occurredAt: "occurred_at",
    },
  },
} as const;

type EntityDefinition =
  (typeof entityDefinitions)[keyof typeof entityDefinitions];

export function createPostgresStores(pool: Pool): {
  users: {
    create(values: {
      id: string;
      email: string;
      displayName?: string;
    }): Promise<Readonly<Record<string, unknown>>>;
  };
  tenants: {
    create(values: {
      id: TenantId;
      name: string;
    }): Promise<Readonly<Record<string, unknown>>>;
  };
  forTenant(tenant: Tenant): TenantStores;
} {
  return {
    users: {
      async create(values) {
        return first(
          await pool.query(
            "insert into users (id, email, display_name) values ($1, $2, $3) returning *",
            [values.id, values.email, values.displayName ?? null],
          ),
        );
      },
    },
    tenants: {
      async create(values) {
        return first(
          await pool.query(
            "insert into tenants (id, name) values ($1, $2) returning *",
            [values.id, values.name],
          ),
        );
      },
    },
    forTenant(tenant) {
      return tenantStores(pool, tenant.id);
    },
  };
}

function tenantStores(pool: Pool, tenantId: TenantId): TenantStores {
  const entities = Object.fromEntries(
    Object.entries(entityDefinitions).map(([name, definition]) => [
      name,
      entityRepository(pool, tenantId, definition),
    ]),
  ) as {
    [K in keyof typeof entityDefinitions]: TenantEntityRepository;
  };
  const jobs = entityRepository(pool, tenantId, {
    table: "jobs",
    key: "id",
    columns: {
      id: "id",
      threadKey: "thread_key",
      request: "request",
      status: "status",
      attempt: "attempt",
      availableAt: "available_at",
    },
  });
  const approvals = entityRepository(pool, tenantId, {
    table: "approvals",
    key: "id",
    columns: {
      id: "id",
      jobId: "job_id",
      action: "action",
      status: "status",
      decidedBy: "decided_by",
      decidedAt: "decided_at",
    },
  });
  return {
    ...entities,
    jobs: {
      ...jobs,
      async create(values) {
        const result = await pool.query(
          "insert into jobs (tenant_id, id, thread_key, request) values ($1, $2, $3, $4) returning *",
          [tenantId, values.id, values.threadKey, values.request],
        );
        return jobRecord(first(result));
      },
      async get(id) {
        const row = await one(
          pool,
          "select * from jobs where tenant_id = $1 and id = $2",
          [tenantId, id],
        );
        return row && jobRecord(row);
      },
      async requestApproval(values) {
        return transaction(pool, async (client) => {
          const job = await lockedJob(client, tenantId, values.jobId);
          if (job.status !== "queued" && job.status !== "running")
            throw new Error(
              `Job ${values.jobId} cannot request approval from ${job.status}`,
            );
          const approval = first(
            await client.query(
              "insert into approvals (tenant_id, id, job_id, action) values ($1, $2, $3, $4) returning *",
              [tenantId, values.approvalId, values.jobId, values.action],
            ),
          );
          const updated = first(
            await client.query(
              "update jobs set status = 'waiting-approval', updated_at = now() where tenant_id = $1 and id = $2 returning *",
              [tenantId, values.jobId],
            ),
          );
          return {
            job: jobRecord(updated),
            approval: approvalRecord(approval),
          };
        });
      },
    },
    approvals: {
      ...approvals,
      async get(id) {
        const row = await one(
          pool,
          "select * from approvals where tenant_id = $1 and id = $2",
          [tenantId, id],
        );
        return row && approvalRecord(row);
      },
      async decide(values) {
        return transaction(pool, async (client) => {
          const approval = await one(
            client,
            "select * from approvals where tenant_id = $1 and id = $2 for update",
            [tenantId, values.id],
          );
          if (!approval) throw new Error(`Unknown approval ${values.id}`);
          if (approval.status !== "pending")
            throw new Error(`Approval ${values.id} is already decided`);
          const job = await lockedJob(
            client,
            tenantId,
            String(approval.job_id),
          );
          if (job.status !== "waiting-approval")
            throw new Error(`Job ${job.id} is not waiting for approval`);
          const decided = first(
            await client.query(
              "update approvals set status = $3, decided_by = $4, decided_at = now() where tenant_id = $1 and id = $2 returning *",
              [tenantId, values.id, values.decision, values.decidedBy],
            ),
          );
          const nextStatus =
            values.decision === "approved" ? "queued" : "failed";
          const updatedJob = first(
            await client.query(
              "update jobs set status = $3, updated_at = now() where tenant_id = $1 and id = $2 returning *",
              [tenantId, job.id, nextStatus],
            ),
          );
          return {
            job: jobRecord(updatedJob),
            approval: approvalRecord(decided),
          };
        });
      },
    },
  };
}

function entityRepository(
  pool: Pool,
  tenantId: TenantId,
  definition:
    | EntityDefinition
    | { table: string; key: string; columns: Record<string, string> },
): TenantEntityRepository {
  const columnsByField: Record<string, string> = definition.columns;
  return {
    async create(values) {
      const entries = Object.entries(values).filter(
        ([, value]) => value !== undefined,
      );
      for (const [name] of entries)
        if (!(name in columnsByField))
          throw new Error(`Unknown ${definition.table} field ${name}`);
      const columns = [
        "tenant_id",
        ...entries.map(([name]) => columnsByField[name] as string),
      ];
      const parameters = columns.map((_, index) => `$${index + 1}`);
      return first(
        await pool.query(
          `insert into ${definition.table} (${columns.join(", ")}) values (${parameters.join(", ")}) returning *`,
          [tenantId, ...entries.map(([, value]) => value)],
        ),
      );
    },
    async get(id) {
      return await one(
        pool,
        `select * from ${definition.table} where tenant_id = $1 and ${definition.key} = $2`,
        [tenantId, id],
      );
    },
    async list() {
      const result = await pool.query(
        `select * from ${definition.table} where tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    },
  };
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function lockedJob(
  client: PoolClient,
  tenantId: TenantId,
  id: string,
): Promise<QueryResultRow> {
  const row = await one(
    client,
    "select * from jobs where tenant_id = $1 and id = $2 for update",
    [tenantId, id],
  );
  if (!row) throw new Error(`Unknown Job ${id}`);
  return row;
}

async function one(
  client: Pool | PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<QueryResultRow | undefined> {
  return (await client.query(sql, [...values])).rows[0];
}
function first(result: { rows: QueryResultRow[] }): QueryResultRow {
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL statement returned no record");
  return row;
}
function jobRecord(row: QueryResultRow): JobRecord {
  return {
    id: String(row.id),
    threadKey: String(row.thread_key),
    request: String(row.request),
    status: row.status as JobStatus,
    attempt: Number(row.attempt),
  };
}
function approvalRecord(row: QueryResultRow): ApprovalRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    action: String(row.action),
    status: row.status as ApprovalStatus,
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
  };
}
