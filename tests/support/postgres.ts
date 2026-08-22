import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";

const exec = promisify(execFile);

export async function disposablePostgres(): Promise<{
  pool: Pool;
  stop(): Promise<void>;
}> {
  const name = `open-agent-test-${randomUUID()}`;
  const { stdout } = await exec("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=test",
    "-e",
    "POSTGRES_DB=open_agent",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  const container = stdout.trim();
  const inspect = async (): Promise<number> => {
    const result = await exec("docker", [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      container,
    ]);
    return Number(result.stdout.trim());
  };
  const port = await inspect();
  const pool = new Pool({
    connectionString: `postgresql://postgres:test@127.0.0.1:${port}/open_agent`,
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await pool.query("select 1");
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!ready) {
    await pool.end();
    await exec("docker", ["stop", container]).catch(() => undefined);
    throw new Error("Disposable PostgreSQL did not become ready");
  }
  return {
    pool,
    async stop() {
      await pool.end();
      await exec("docker", ["stop", container]).catch(() => undefined);
    },
  };
}
