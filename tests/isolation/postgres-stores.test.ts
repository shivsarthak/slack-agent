import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/hosted/postgres/migrate.ts";
import { createPostgresStores } from "../../src/hosted/postgres/stores.ts";
import {
  postgresConfigurationPersistence,
  postgresCredentialPersistence,
} from "../../src/hosted/postgres/secrets.ts";
import { CredentialVault } from "../../src/credentials/vault.ts";
import { TenantConfigurationVault } from "../../src/credentials/configuration-vault.ts";
import type { KeyProvider } from "../../src/credentials/envelope.ts";
import { tenantId } from "../../src/tenant.ts";
import { postgresSessionStore } from "../../src/hosted/postgres/sessions.ts";
import { disposablePostgres } from "../support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;

beforeAll(async () => {
  database = await disposablePostgres();
  await migrate(database.pool);
}, 30_000);
afterAll(async () => database.stop());

describe("Tenant-bound PostgreSQL stores", () => {
  it("keeps resumable engine metadata and interruption Tenant-scoped", async () => {
    const control = createPostgresStores(database.pool);
    const alpha = { id: tenantId("10101010-1010-4010-8010-101010101010") };
    const beta = { id: tenantId("20202020-2020-4020-8020-202020202020") };
    await control.tenants.create({ id: alpha.id, name: "Session Alpha" });
    await control.tenants.create({ id: beta.id, name: "Session Beta" });
    const store = postgresSessionStore(database.pool);
    const thread = { channel: "C_SHARED", ts: "123.456" };

    await store.set(alpha, thread, {
      id: "pi-alpha",
      engine: "pi",
      locator: "/tenants/alpha/sessions/pi-alpha.jsonl",
      interrupted: true,
    });
    await expect(store.get(beta, thread)).resolves.toBeUndefined();
    await expect(store.get(alpha, thread)).resolves.toEqual({
      id: "pi-alpha",
      engine: "pi",
      locator: "/tenants/alpha/sessions/pi-alpha.jsonl",
      interrupted: true,
    });

    await store.set(alpha, thread, {
      id: "pi-alpha",
      engine: "pi",
      locator: "/tenants/alpha/sessions/pi-alpha.jsonl",
      interrupted: false,
    });
    await expect(store.get(alpha, thread)).resolves.toMatchObject({
      interrupted: false,
    });
  });

  it("persists only encrypted Tenant configuration and credentials across rotation and revocation", async () => {
    const control = createPostgresStores(database.pool);
    const alpha = tenantId("11111111-1111-4111-8111-111111111111");
    const beta = tenantId("22222222-2222-4222-8222-222222222222");
    await control.tenants.create({ id: alpha, name: "Secret Alpha" });
    await control.tenants.create({ id: beta, name: "Secret Beta" });
    let currentVersion = 1;
    const material = new Map<number, Uint8Array>([
      [1, new Uint8Array(32).fill(11)],
    ]);
    const keys: KeyProvider = {
      async currentVersion() {
        return currentVersion;
      },
      async key(version) {
        const key = material.get(version);
        if (!key) throw new Error("unknown test key");
        return key;
      },
    };
    const credentials = postgresCredentialPersistence(database.pool);
    const configurations = postgresConfigurationPersistence(database.pool);
    const alphaCredentials = new CredentialVault(alpha, keys, credentials);
    const betaCredentials = new CredentialVault(beta, keys, credentials);
    const alphaConfiguration = new TenantConfigurationVault(
      alpha,
      keys,
      configurations,
    );

    await alphaCredentials.store({
      id: "openai-primary",
      kind: "openai",
      secret: "sk-database-secret",
    });
    await alphaConfiguration.store({
      slack: { teamId: "T-ALPHA" },
      mcpServers: [],
    });
    const raw = await database.pool.query(
      "select encrypted_value from credentials where tenant_id = $1 union all select encrypted_value from tenant_configurations where tenant_id = $1",
      [alpha],
    );
    expect(JSON.stringify(raw.rows)).not.toMatch(/sk-database-secret|T-ALPHA/);
    await expect(
      betaCredentials.read("openai-primary"),
    ).resolves.toBeUndefined();

    currentVersion = 2;
    material.set(2, new Uint8Array(32).fill(22));
    await alphaCredentials.rotateEncryption("openai-primary");
    await alphaConfiguration.rotateEncryption();
    await expect(
      alphaCredentials.read("openai-primary"),
    ).resolves.toMatchObject({ secret: "sk-database-secret", keyVersion: 2 });
    await expect(alphaConfiguration.read()).resolves.toMatchObject({
      configuration: { slack: { teamId: "T-ALPHA" }, mcpServers: [] },
      version: 1,
      keyVersion: 2,
    });

    await alphaCredentials.revoke("openai-primary");
    await expect(
      alphaCredentials.read("openai-primary"),
    ).resolves.toBeUndefined();
  });

  it("rejects cross-Tenant repository access and mismatched database identities", async () => {
    const control = createPostgresStores(database.pool);
    const alpha = tenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const beta = tenantId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await control.tenants.create({ id: alpha, name: "Alpha" });
    await control.tenants.create({ id: beta, name: "Beta" });
    await control.users.create({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      email: "owner@example.test",
    });
    const alphaStores = control.forTenant({ id: alpha });
    const betaStores = control.forTenant({ id: beta });
    await alphaStores.jobs.create({
      id: "job-a",
      threadKey: "C1:1",
      request: "alpha work",
    });
    await alphaStores.schedules.create({
      id: "schedule-a",
      creatorUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      task: "alpha schedule",
      destination: { channelId: "C1" },
      timezone: "UTC",
      rule: { kind: "daily" },
      state: "active",
    });
    expect(await betaStores.jobs.get("job-a")).toBeUndefined();
    await expect(
      database.pool.query(
        "insert into occurrences (tenant_id, id, schedule_id, due_at, outcome, manual) values ($1, $2, $3, now(), 'running', false)",
        [beta, "occurrence-x", "schedule-a"],
      ),
    ).rejects.toThrow();
  });

  it("atomically preserves Job and approval invariants", async () => {
    const control = createPostgresStores(database.pool);
    const tenant = { id: tenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc") };
    await control.tenants.create({ id: tenant.id, name: "Atomic" });
    const stores = control.forTenant(tenant);
    await stores.jobs.create({
      id: "job-atomic",
      threadKey: "C2:2",
      request: "deploy",
    });
    const approval = await stores.jobs.requestApproval({
      jobId: "job-atomic",
      approvalId: "approval-1",
      action: "deploy production",
    });
    expect(approval.job.status).toBe("waiting-approval");
    expect(approval.approval.status).toBe("pending");
    const decided = await stores.approvals.decide({
      id: "approval-1",
      decision: "approved",
      decidedBy: "user-1",
    });
    expect(decided.approval.status).toBe("approved");
    expect(decided.job.status).toBe("queued");
    const audit = await database.pool.query(
      "select actor_id,event_type,subject_id,payload from audit_events where tenant_id=$1 and subject_id='approval-1' order by id",
      [tenant.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: "user-1",
        event_type: "approval.decided",
        subject_id: "approval-1",
        payload: { decision: "approved", jobId: "job-atomic" },
      },
    ]);
    await expect(
      stores.approvals.decide({
        id: "approval-1",
        decision: "denied",
        decidedBy: "user-2",
      }),
    ).rejects.toThrow(/already decided/);
  });

  it("rejects unattributed audit records", async () => {
    const control = createPostgresStores(database.pool);
    const tenant = { id: tenantId("dddddddd-dddd-4ddd-8ddd-dddddddddddd") };
    await control.tenants.create({ id: tenant.id, name: "Attributed audit" });
    await expect(control.forTenant(tenant).auditEvents.create({
      eventType: "credential.rotated", subjectType: "credential", subjectId: "github",
    })).rejects.toThrow(/actor/i);
  });
});
