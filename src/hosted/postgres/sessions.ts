import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SessionRecord, SessionStore } from "../../ports/sessions.ts";
import { threadKey, type Thread } from "../../thread.ts";
import type { Tenant } from "../../tenant.ts";

/** PostgreSQL metadata for engine-owned Session content. */
export function postgresSessionStore(pool: Pool): SessionStore {
  return {
    async get(
      tenant: Tenant,
      thread: Thread,
    ): Promise<SessionRecord | undefined> {
      const result = await pool.query<{
        engine_session_id: string;
        engine: string;
        locator: string;
        interrupted: boolean;
      }>(
        "select engine_session_id, engine, locator, interrupted from sessions where tenant_id = $1 and thread_key = $2",
        [tenant.id, threadKey(thread)],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            id: row.engine_session_id,
            engine: row.engine,
            locator: row.locator,
            interrupted: row.interrupted,
          };
    },

    async set(
      tenant: Tenant,
      thread: Thread,
      record: SessionRecord,
    ): Promise<void> {
      if (!record.engine || !record.locator) {
        throw new Error(
          "Hosted Session metadata requires engine and opaque locator",
        );
      }
      const key = threadKey(thread);
      const id = createHash("sha256").update(key).digest("hex");
      await pool.query(
        `insert into sessions (tenant_id, id, thread_key, engine, engine_session_id, locator, interrupted)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, thread_key) do update set
           engine = excluded.engine,
           engine_session_id = excluded.engine_session_id,
           locator = excluded.locator,
           interrupted = excluded.interrupted,
           updated_at = now()`,
        [
          tenant.id,
          id,
          key,
          record.engine,
          record.id,
          record.locator,
          record.interrupted,
        ],
      );
    },
  };
}
