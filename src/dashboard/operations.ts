import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TenantRole } from "./auth.ts";

export interface TenantOperationAccess {
  userId: string;
  tenantId: string;
  role: TenantRole;
}

export interface TenantOperationsDependencies {
  pool: Pool;
  authorize(
    request: Request,
    tenantId: string,
    allowed: readonly TenantRole[],
  ): Promise<TenantOperationAccess | undefined>;
  now?: () => Date;
}

const READ_ROLES: readonly TenantRole[] = ["owner", "admin", "member"];
const MUTATE_ROLES: readonly TenantRole[] = ["owner", "admin"];

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function records(rows: QueryResultRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const value: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(row)) {
      value[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = field;
    }
    return value;
  });
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

/** Tenant-scoped operational API. It intentionally never selects credential or configuration values. */
export function createTenantOperationsHttpHandler(dependencies: TenantOperationsDependencies) {
  const now = dependencies.now ?? (() => new Date());
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get("tenantId");
    if (!tenantId) return json({ error: "tenant required" }, 400);
    const path = url.pathname.replace(/^\/api\/operations\/?/, "");
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    const access = await dependencies.authorize(request, tenantId, mutation ? MUTATE_ROLES : READ_ROLES);
    if (!access || access.tenantId !== tenantId) return json({ error: "forbidden" }, 403);

    try {
      if (request.method === "GET" && path === "integrations") {
        const [slack, credentials, onboarding] = await Promise.all([
          dependencies.pool.query("select 1 from slack_installations where tenant_id=$1 and encrypted_bot_token is not null limit 1", [tenantId]),
          dependencies.pool.query<{ kind: string }>("select kind from credentials where tenant_id=$1 and revoked_at is null", [tenantId]),
          dependencies.pool.query("select id,status,verification_url,expires_at,failure,created_at,updated_at from openai_codex_onboarding_attempts where tenant_id=$1 order by created_at desc limit 1", [tenantId]),
        ]);
        const kinds = new Set(credentials.rows.map((row) => row.kind));
        return json({
          slack: slack.rowCount ? "connected" : "not-connected",
          openai: kinds.has("openai") ? "connected" : "not-connected",
          mcp: kinds.has("mcp") ? "configured" : "not-configured",
          onboarding: onboarding.rows[0] ? records(onboarding.rows)[0] : null,
        });
      }

      const reads: Record<string, { sql: string; key: string }> = {
        jobs: { key: "jobs", sql: "select id,thread_key,request,status,attempt,last_error,cancelled_by,cancelled_reason,cancelled_at,replay_of,available_at,created_at,updated_at from jobs where tenant_id=$1 order by created_at desc,id" },
        sessions: { key: "sessions", sql: "select id,thread_key,engine,interrupted,created_at,updated_at from sessions where tenant_id=$1 order by updated_at desc,id" },
        schedules: { key: "schedules", sql: "select id,creator_user_id,task,destination,timezone,rule,state,next_due_at,created_at,updated_at from schedules where tenant_id=$1 and state <> 'deleted' order by created_at desc,id" },
        occurrences: { key: "occurrences", sql: "select id,schedule_id,job_id,due_at,started_at,finished_at,outcome,manual,details from occurrences where tenant_id=$1 order by due_at desc,id" },
        approvals: { key: "approvals", sql: "select id,job_id,action,status,decided_by,decided_at,created_at from approvals where tenant_id=$1 order by created_at desc,id" },
        "dead-letters": { key: "deadLetters", sql: "select id,thread_key,request,status,attempt,last_error,created_at,updated_at from jobs where tenant_id=$1 and status='dead-letter' order by updated_at desc,id" },
        audit: { key: "events", sql: "select id,actor_id,event_type,subject_type,subject_id,payload,occurred_at from audit_events where tenant_id=$1 order by occurred_at desc,id desc limit 250" },
        artifacts: { key: "artifacts", sql: "select id,subject_id as job_id,payload,occurred_at from audit_events where tenant_id=$1 and event_type in ('artifact.created','artifact.shared') order by occurred_at desc,id desc" },
      };
      if (request.method === "GET" && reads[path]) {
        const read = reads[path]!;
        const result = await dependencies.pool.query(read.sql, [tenantId]);
        return json({ [read.key]: records(result.rows) });
      }

      const approval = path.match(/^approvals\/([^/]+)$/);
      if (request.method === "POST" && approval) {
        const body = await request.json().catch(() => null) as { decision?: unknown; idempotencyKey?: unknown } | null;
        if ((body?.decision !== "approved" && body?.decision !== "denied") || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim())
          return json({ error: "decision and idempotencyKey are required" }, 400);
        const id = decodeURIComponent(approval[1]!);
        const result = await transaction(dependencies.pool, async (client) => {
          const locked = await client.query("select * from approvals where tenant_id=$1 and id=$2 for update", [tenantId, id]);
          const current = locked.rows[0];
          if (!current) return { status: 404 as const };
          const prior = await client.query("select 1 from audit_events where tenant_id=$1 and event_type='approval.decided' and subject_id=$2 and payload->>'idempotencyKey'=$3", [tenantId, id, body.idempotencyKey]);
          if (prior.rowCount) return { status: 200 as const, body: { id, status: current.status, idempotent: true } };
          if (current.status !== "pending") return { status: 409 as const };
          await client.query("update approvals set status=$3,decided_by=$4,decided_at=$5 where tenant_id=$1 and id=$2", [tenantId, id, body.decision, access.userId, now()]);
          await client.query("insert into audit_events(tenant_id,actor_id,event_type,subject_type,subject_id,payload,occurred_at) values ($1,$2,'approval.decided','approval',$3,$4,$5)", [tenantId, access.userId, id, { decision: body.decision, idempotencyKey: body.idempotencyKey }, now()]);
          return { status: 200 as const, body: { id, status: body.decision, idempotent: false } };
        });
        if (result.status === 404) return json({ error: "approval not found" }, 404);
        if (result.status === 409) return json({ error: "approval already decided" }, 409);
        return json(result.body);
      }

      const replay = path.match(/^dead-letters\/([^/]+)\/replay$/);
      if (request.method === "POST" && replay) {
        const body = await request.json().catch(() => null) as { reason?: unknown; idempotencyKey?: unknown } | null;
        if (typeof body?.reason !== "string" || !body.reason.trim() || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim())
          return json({ error: "reason and idempotencyKey are required" }, 400);
        const sourceId = decodeURIComponent(replay[1]!);
        const result = await transaction(dependencies.pool, async (client) => {
          // Serialize attempts for one dead letter before checking the audit key. Under
          // READ COMMITTED, a waiter sees the winner's audit event after this lock opens.
          const source = await client.query("select * from jobs where tenant_id=$1 and id=$2 for update", [tenantId, sourceId]);
          if (!source.rows[0]) return { status: 404 as const };
          const prior = await client.query("select j.* from audit_events a join jobs j on j.tenant_id=a.tenant_id and j.id=a.subject_id where a.tenant_id=$1 and a.event_type='job.replayed' and a.payload->>'sourceJobId'=$2 and a.payload->>'idempotencyKey'=$3 for update of j", [tenantId, sourceId, body.idempotencyKey]);
          if (prior.rows[0]) return { status: 200 as const, job: records(prior.rows)[0], idempotent: true };
          if (source.rows[0].status !== "dead-letter") return { status: 409 as const };
          const id = randomUUID();
          const created = await client.query("insert into jobs(tenant_id,id,thread_key,request,idempotency_key,replay_of,available_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$7,$7) returning id,thread_key,request,status,attempt,replay_of,available_at,created_at,updated_at", [tenantId, id, source.rows[0].thread_key, source.rows[0].request, `dashboard-replay:${sourceId}:${body.idempotencyKey}`, sourceId, now()]);
          await client.query("insert into audit_events(tenant_id,actor_id,event_type,subject_type,subject_id,payload,occurred_at) values ($1,$2,'job.replayed','job',$3,$4,$5)", [tenantId, access.userId, id, { sourceJobId: sourceId, reason: body.reason, idempotencyKey: body.idempotencyKey }, now()]);
          return { status: 201 as const, job: records(created.rows)[0], idempotent: false };
        });
        if (result.status === 404) return json({ error: "dead letter not found" }, 404);
        if (result.status === 409) return json({ error: "job is not dead-lettered" }, 409);
        return json({ job: result.job, idempotent: result.idempotent }, result.status);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.error("Tenant operations request failed", error);
      return json({ error: "operation failed" }, 500);
    }
  };
}
