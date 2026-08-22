import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { Pool } from "pg";
import type { KeyProvider } from "../credentials/envelope.ts";
import { CredentialVault } from "../credentials/vault.ts";
import { listenLauncherApi } from "../launcher/api.ts";
import { dockerEngine } from "../launcher/docker-engine.ts";
import { createLauncher } from "../launcher/launcher.ts";
import { tenantId } from "../tenant.ts";
import { migrate } from "./postgres/migrate.ts";
import { postgresCredentialPersistence } from "./postgres/secrets.ts";

const mode = process.argv[2];

if (mode === "migrate") {
  const pool = new Pool({ connectionString: required("DATABASE_URL") });
  await migrate(pool).finally(() => pool.end());
} else if (mode === "launcher-health") {
  await access(required("LAUNCHER_SOCKET"));
} else if (mode === "worker") {
  const pool = new Pool({ connectionString: required("DATABASE_URL") });
  await pool.query("select 1");
  const server = createServer(async (request, response) => {
    if (request.url !== "/health") return response.writeHead(404).end();
    try {
      await pool.query("select 1");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"status":"ok"}');
    } catch {
      response.writeHead(503).end();
    }
  });
  server.listen(8081, "0.0.0.0");
  shutdown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });
} else if (mode === "launcher") {
  const pool = new Pool({ connectionString: required("DATABASE_URL") });
  const persistence = postgresCredentialPersistence(pool);
  const launcher = createLauncher({
    engine: dockerEngine(),
    tenantsRoot: required("TENANTS_ROOT"),
    credentialsRoot: required("CREDENTIALS_ROOT"),
    limits: {
      memoryBytes: positiveInteger("WORKER_MEMORY_BYTES", 2_147_483_648),
      nanoCpus: positiveInteger("WORKER_NANO_CPUS", 2_000_000_000),
      pids: positiveInteger("WORKER_PIDS", 256),
      timeoutMs: positiveInteger("WORKER_TIMEOUT_MS", 21_600_000),
    },
    async credentialFor(owner) {
      const tenant = tenantId(owner);
      const result = await pool.query<{ id: string }>(
        "select id from credentials where tenant_id=$1 and revoked_at is null order by id",
        [tenant],
      );
      const vault = new CredentialVault(tenant, environmentKey(), persistence);
      const credentials = await Promise.all(
        result.rows.map(({ id }) => vault.read(id)),
      );
      return JSON.stringify({ credentials: credentials.filter(Boolean) });
    },
  });
  await launcher.reconcile();
  const api = await listenLauncherApi({
    socketPath: required("LAUNCHER_SOCKET"),
    launcher,
  });
  shutdown(async () => {
    await api.close();
    await pool.end();
  });
} else {
  throw new Error(`Unknown hosted runtime mode: ${mode ?? "(missing)"}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function environmentKey(): KeyProvider {
  const version = positiveInteger("CREDENTIAL_ENCRYPTION_KEY_VERSION", 1);
  const key = Buffer.from(required("CREDENTIAL_ENCRYPTION_KEY"), "base64");
  if (key.byteLength !== 32)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 bytes");
  return {
    currentVersion: async () => version,
    key: async (requested) => {
      if (requested !== version)
        throw new Error(`Encryption key version ${requested} is unavailable`);
      return key;
    },
  };
}

function shutdown(close: () => Promise<void>): void {
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
