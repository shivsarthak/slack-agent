import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

/** Apply every checked-in SQL migration once, refusing edited migration history. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('open-agent:migrations'))",
    );
    await client.query(`create table if not exists __open_agent_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now()
    )`);
    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of files) {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "select checksum from __open_agent_migrations where name = $1",
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration ${name} has been edited`);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into __open_agent_migrations (name, checksum) values ($1, $2)",
          [name, checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('open-agent:migrations'))")
      .catch(() => undefined);
    client.release();
  }
}
