import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { tenantId } from "../../tenant.ts";
import type { SlackHttpPersistence, SlackInstallation } from "./http.ts";

const stateHash = (state: string): string =>
  createHash("sha256").update(state).digest("hex");

async function transaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Durable, atomic persistence for the hosted Slack HTTP boundary. */
export function postgresSlackHttpPersistence(pool: Pool): SlackHttpPersistence {
  return {
    async saveState(state, tenant, expiresAt) {
      await pool.query(
        "delete from slack_oauth_states where expires_at <= now()",
      );
      await pool.query(
        "insert into slack_oauth_states (state_hash, tenant_id, expires_at) values ($1, $2, $3)",
        [stateHash(state), tenant.id, expiresAt],
      );
    },

    async consumeState(state) {
      const result = await pool.query<{ tenant_id: string }>(
        "delete from slack_oauth_states where state_hash = $1 and expires_at > now() returning tenant_id",
        [stateHash(state)],
      );
      const id = result.rows[0]?.tenant_id;
      return id ? { id: tenantId(id) } : undefined;
    },

    async bindInstallation(installation: SlackInstallation) {
      await transaction(pool, async (client) => {
        const existing = await client.query<{
          tenant_id: string;
          slack_team_id: string;
        }>(
          "select tenant_id, slack_team_id from slack_installations where tenant_id = $1 or slack_team_id = $2 for update",
          [installation.tenant.id, installation.teamId],
        );
        if (
          existing.rows.some(
            (row) =>
              row.tenant_id !== installation.tenant.id ||
              row.slack_team_id !== installation.teamId,
          )
        )
          throw new Error(
            "Slack workspace or Tenant is already bound to another installation",
          );
        await client.query(
          `insert into slack_installations
            (tenant_id, id, slack_team_id, team_name, enterprise_id, bot_user_id, encrypted_bot_token)
           values ($1, $2, $2, $3, $4, $5, $6)
           on conflict (tenant_id) do update set
             team_name = excluded.team_name,
             enterprise_id = excluded.enterprise_id,
             bot_user_id = excluded.bot_user_id,
             encrypted_bot_token = excluded.encrypted_bot_token,
             updated_at = now()`,
          [
            installation.tenant.id,
            installation.teamId,
            installation.teamName,
            installation.enterpriseId ?? null,
            installation.botUserId,
            installation.encryptedBotToken,
          ],
        );
      });
    },

    async tenantForTeam(teamId) {
      const result = await pool.query<{ tenant_id: string }>(
        "select tenant_id from slack_installations where slack_team_id = $1",
        [teamId],
      );
      const id = result.rows[0]?.tenant_id;
      return id ? { id: tenantId(id) } : undefined;
    },

    async createJobOnce(key, expiresAt, job) {
      return transaction(pool, async (client) => {
        await client.query(
          "delete from slack_deliveries where delivery_key = $1 and expires_at <= now()",
          [key],
        );
        const claim = await client.query(
          `insert into slack_deliveries (delivery_key, tenant_id, expires_at)
           values ($1, $2, $3) on conflict (delivery_key) do nothing returning delivery_key`,
          [key, job.tenant.id, expiresAt],
        );
        if (claim.rowCount === 0) return false;
        await client.query(
          "insert into jobs (tenant_id, id, thread_key, request) values ($1, $2, $3, $4)",
          [job.tenant.id, job.id, job.threadKey, job.request],
        );
        return true;
      });
    },
  };
}
