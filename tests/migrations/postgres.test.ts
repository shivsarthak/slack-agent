import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../../src/hosted/postgres/migrate.ts";
import { disposablePostgres } from "../support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;
let pool: Pool;

beforeAll(async () => {
  database = await disposablePostgres();
  pool = database.pool;
}, 30_000);
afterAll(async () => database.stop());

describe("hosted PostgreSQL migrations", () => {
  it("migrates a fresh database and is safe to upgrade again", async () => {
    await migrate(pool);
    await migrate(pool);
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "users",
        "tenants",
        "memberships",
        "dashboard_magic_links",
        "dashboard_sessions",
        "slack_installations",
        "credentials",
        "jobs",
        "sessions",
        "schedules",
        "occurrences",
        "approvals",
        "quotas",
        "audit_events",
      ]),
    );
  });

  it("upgrades a database that has only the initial migration", async () => {
    const upgrade = await disposablePostgres();
    try {
      const migrationPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../drizzle/0000_hosted_state.sql",
      );
      const sql = await readFile(migrationPath, "utf8");
      await upgrade.pool.query(sql);
      await upgrade.pool.query(`create table __open_agent_migrations (
        name text primary key, checksum text not null, applied_at timestamptz not null default now()
      )`);
      await upgrade.pool.query(
        "insert into __open_agent_migrations (name, checksum) values ($1, $2)",
        [
          "0000_hosted_state.sql",
          createHash("sha256").update(sql).digest("hex"),
        ],
      );
      await migrate(upgrade.pool);
      const applied = await upgrade.pool.query<{ name: string }>(
        "select name from __open_agent_migrations order by name",
      );
      expect(applied.rows.map((row) => row.name)).toEqual([
        "0000_hosted_state.sql",
        "0001_tenant_membership_integrity.sql",
        "0002_dashboard_identity.sql",
      ]);
    } finally {
      await upgrade.stop();
    }
  }, 30_000);
});
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
