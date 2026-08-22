import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/hosted/postgres/migrate.ts";
import { postgresSlackHttpPersistence } from "../../src/hosted/slack/postgres.ts";
import { tenantId } from "../../src/tenant.ts";
import { disposablePostgres } from "../support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;

beforeAll(async () => {
  database = await disposablePostgres();
  await migrate(database.pool);
}, 30_000);
afterAll(async () => database.stop());

describe("PostgreSQL Slack HTTP persistence", () => {
  it("consumes OAuth state once and refuses cross-Tenant workspace rebinding", async () => {
    const alpha = { id: tenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") };
    const beta = { id: tenantId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") };
    await database.pool.query(
      "insert into tenants (id, name) values ($1, 'Alpha'), ($2, 'Beta')",
      [alpha.id, beta.id],
    );
    const persistence = postgresSlackHttpPersistence(database.pool);
    await persistence.saveState(
      "secret-state",
      alpha,
      new Date(Date.now() + 60_000),
    );
    await expect(persistence.consumeState("secret-state")).resolves.toEqual(
      alpha,
    );
    await expect(
      persistence.consumeState("secret-state"),
    ).resolves.toBeUndefined();

    await persistence.bindInstallation({
      tenant: alpha,
      teamId: "T-ONE",
      teamName: "One",
      botUserId: "B1",
      encryptedBotToken: "ciphertext",
    });
    await expect(
      persistence.bindInstallation({
        tenant: beta,
        teamId: "T-ONE",
        teamName: "One",
        botUserId: "B2",
        encryptedBotToken: "other-ciphertext",
      }),
    ).rejects.toThrow(/already bound/);
    await expect(persistence.tenantForTeam("T-ONE")).resolves.toEqual(alpha);
  });

  it("atomically deduplicates a Tenant-scoped Job", async () => {
    const tenant = { id: tenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc") };
    await database.pool.query(
      "insert into tenants (id, name) values ($1, 'Jobs')",
      [tenant.id],
    );
    const persistence = postgresSlackHttpPersistence(database.pool);
    const job = {
      tenant,
      id: "Ev-1",
      threadKey: "C1:1.2",
      request: "investigate",
    };
    await expect(
      persistence.createJobOnce(
        "event:T1:Ev-1",
        new Date(Date.now() + 60_000),
        job,
      ),
    ).resolves.toBe(true);
    await expect(
      persistence.createJobOnce(
        "event:T1:Ev-1",
        new Date(Date.now() + 60_000),
        job,
      ),
    ).resolves.toBe(false);
    const rows = await database.pool.query(
      "select tenant_id, id from jobs where tenant_id = $1 and id = $2",
      [tenant.id, job.id],
    );
    expect(rows.rows).toEqual([{ tenant_id: tenant.id, id: job.id }]);
  });
});
