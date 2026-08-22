import type { Pool, QueryResultRow } from "pg";
import type {
  OnboardingAttempt,
  OnboardingPersistence,
  OnboardingStatus,
} from "../../openai/onboarding.ts";
import { tenantId, type TenantId } from "../../tenant.ts";

function attempt(row: QueryResultRow): OnboardingAttempt {
  return {
    id: String(row.id),
    tenantId: tenantId(String(row.tenant_id)),
    initiatedByUserId: String(row.initiated_by_user_id),
    status: String(row.status) as OnboardingStatus,
    ...(row.verification_url
      ? { verificationUrl: String(row.verification_url) }
      : {}),
    ...(row.user_code ? { userCode: String(row.user_code) } : {}),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
    ...(row.failure ? { failure: "provider-error" as const } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function postgresOnboardingPersistence(
  pool: Pool,
): OnboardingPersistence {
  return {
    async active(owner: TenantId) {
      const result = await pool.query(
        `select * from openai_codex_onboarding_attempts
         where tenant_id = $1 and status = 'pending'`,
        [owner],
      );
      return result.rows[0] ? attempt(result.rows[0]) : undefined;
    },

    async create(record) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtext('openai-onboarding:' || $1))",
          [record.tenantId],
        );
        const existing = await client.query(
          `select * from openai_codex_onboarding_attempts
           where tenant_id = $1 and status = 'pending'`,
          [record.tenantId],
        );
        if (existing.rows[0]) {
          await client.query("commit");
          return attempt(existing.rows[0]);
        }
        const inserted = await client.query(
          `insert into openai_codex_onboarding_attempts
           (tenant_id, id, initiated_by_user_id, status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6) returning *`,
          [
            record.tenantId,
            record.id,
            record.initiatedByUserId,
            record.status,
            record.createdAt,
            record.updatedAt,
          ],
        );
        await client.query("commit");
        return attempt(inserted.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async get(owner, id) {
      const result = await pool.query(
        `select * from openai_codex_onboarding_attempts
         where tenant_id = $1 and id = $2`,
        [owner, id],
      );
      return result.rows[0] ? attempt(result.rows[0]) : undefined;
    },

    async update(record, expectedStatus) {
      const result = await pool.query(
        `update openai_codex_onboarding_attempts set
           status = $4, verification_url = $5, user_code = $6,
           expires_at = $7, failure = $8, updated_at = $9
         where tenant_id = $1 and id = $2 and status = $3`,
        [
          record.tenantId,
          record.id,
          expectedStatus,
          record.status,
          record.verificationUrl ?? null,
          record.userCode ?? null,
          record.expiresAt ?? null,
          record.failure ?? null,
          record.updatedAt,
        ],
      );
      return result.rowCount === 1;
    },
  };
}
