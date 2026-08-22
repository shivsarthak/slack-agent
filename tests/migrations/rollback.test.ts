import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/hosted/postgres/migrate.ts";
import { disposablePostgres } from "../support/postgres.ts";

describe("release rollback rehearsal", () => {
  it("preserves records and the pre-upgrade query surface after forward migrations", async () => {
    const database = await disposablePostgres();
    try {
      const migrationPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../drizzle/0000_hosted_state.sql",
      );
      const initialSql = await readFile(migrationPath, "utf8");
      await database.pool.query(initialSql);
      await database.pool.query(`create table __open_agent_migrations (
        name text primary key, checksum text not null, applied_at timestamptz not null default now()
      )`);
      await database.pool.query(
        "insert into __open_agent_migrations(name,checksum) values($1,$2)",
        [
          "0000_hosted_state.sql",
          createHash("sha256").update(initialSql).digest("hex"),
        ],
      );
      const tenant = await database.pool.query<{ id: string }>(
        "insert into tenants(id,name) values('00000000-0000-4000-8000-000000000019','rollback') returning id",
      );
      await database.pool.query(
        "insert into jobs(id,tenant_id,thread_key,request,status) values('rollback-job',$1,'C1:1.0','safe','queued')",
        [tenant.rows[0]!.id],
      );

      await migrate(database.pool);

      const oldReleaseRead = await database.pool.query(
        "select id, tenant_id, thread_key, request, status from jobs where id='rollback-job'",
      );
      expect(oldReleaseRead.rows).toEqual([
        expect.objectContaining({
          id: "rollback-job",
          request: "safe",
          status: "queued",
        }),
      ]);
    } finally {
      await database.stop();
    }
  }, 30_000);
});
