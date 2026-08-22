import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../src/hosted/postgres/migrate.ts";
import {
  createDashboardAuth,
  createDashboardAuthHttpHandler,
  authorizeTenantRequest,
  type MailMessage,
} from "../src/dashboard/auth.ts";
import { disposablePostgres } from "./support/postgres.ts";

let database: Awaited<ReturnType<typeof disposablePostgres>>;
let pool: Pool;

beforeAll(async () => {
  database = await disposablePostgres();
  pool = database.pool;
  await migrate(pool);
}, 30_000);
afterAll(async () => database.stop());

describe("dashboard identity HTTP seam", () => {
  it("expires magic links after fifteen minutes and never replays one", async () => {
    let now = new Date("2026-08-22T00:00:00Z");
    const messages: MailMessage[] = [];
    const auth = createDashboardAuth({
      pool,
      clock: { now: () => now },
      mail: { send: async (message) => void messages.push(message) },
      publicUrl: "http://dashboard.test",
    });

    await auth.requestMagicLink("person@example.com");
    const token = new URL(messages.at(-1)!.magicLink).searchParams.get(
      "token",
    )!;
    now = new Date("2026-08-22T00:15:01Z");
    await expect(auth.consumeMagicLink(token)).resolves.toBeUndefined();

    now = new Date("2026-08-22T01:00:00Z");
    await auth.requestMagicLink("person@example.com");
    const fresh = new URL(messages.at(-1)!.magicLink).searchParams.get(
      "token",
    )!;
    await expect(auth.consumeMagicLink(fresh)).resolves.toBeDefined();
    await expect(auth.consumeMagicLink(fresh)).resolves.toBeUndefined();
  });

  it("rotates and logs out seven-day database sessions", async () => {
    const messages: MailMessage[] = [];
    const auth = createDashboardAuth({
      pool,
      mail: { send: async (message) => void messages.push(message) },
      publicUrl: "http://dashboard.test",
    });
    const handle = createDashboardAuthHttpHandler(auth);
    await handle(
      new Request("http://dashboard.test/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "rotate@example.com" }),
      }),
    );
    const token = new URL(messages.at(-1)!.magicLink).searchParams.get(
      "token",
    )!;
    const login = await handle(
      new Request(`http://dashboard.test/api/auth/magic-link?token=${token}`),
    );
    expect(login.status).toBe(303);
    const firstCookie = login.headers.get("set-cookie")!;
    expect(firstCookie).toContain("Max-Age=604800");

    const rotated = await handle(
      new Request("http://dashboard.test/api/auth/session", {
        method: "POST",
        headers: { cookie: firstCookie },
      }),
    );
    expect(rotated.status).toBe(200);
    const secondCookie = rotated.headers.get("set-cookie")!;
    expect(secondCookie).not.toBe(firstCookie);
    expect(
      (
        await handle(
          new Request("http://dashboard.test/api/auth/session", {
            headers: { cookie: firstCookie },
          }),
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await handle(
          new Request("http://dashboard.test/api/auth/session", {
            method: "DELETE",
            headers: { cookie: secondCookie },
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handle(
          new Request("http://dashboard.test/api/auth/session", {
            headers: { cookie: secondCookie },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("lists only memberships and enforces owner/admin/member Tenant roles", async () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    const otherUserId = "10000000-0000-4000-8000-000000000002";
    const tenantIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004",
    ];
    await pool.query(
      "insert into users (id, email) values ($1, $2), ($3, $4)",
      [userId, "roles@example.com", otherUserId, "other@example.com"],
    );
    for (const [index, tenantId] of tenantIds.entries()) {
      await pool.query("insert into tenants (id, name) values ($1, $2)", [
        tenantId,
        `Tenant ${index}`,
      ]);
    }
    await pool.query(
      "insert into memberships (tenant_id, user_id, role) values ($1,$4,'owner'),($2,$4,'admin'),($3,$4,'member'),($5,$6,'owner')",
      [...tenantIds.slice(0, 3), userId, tenantIds[3], otherUserId],
    );
    const auth = createDashboardAuth({
      pool,
      mail: { send: async () => undefined },
      publicUrl: "http://dashboard.test",
    });
    expect((await auth.listTenants(userId)).map((tenant) => tenant.id)).toEqual(
      tenantIds.slice(0, 3),
    );
    expect(
      await auth.authorize(userId, tenantIds[0]!, ["owner"]),
    ).toBeDefined();
    expect(
      await auth.authorize(userId, tenantIds[1]!, ["owner", "admin"]),
    ).toBeDefined();
    expect(
      await auth.authorize(userId, tenantIds[2]!, ["owner", "admin"]),
    ).toBeUndefined();
    expect(
      await auth.authorize(userId, tenantIds[3]!, ["owner", "admin", "member"]),
    ).toBeUndefined();

    const messages: MailMessage[] = [];
    const httpAuth = createDashboardAuth({
      pool,
      mail: { send: async (message) => void messages.push(message) },
      publicUrl: "http://dashboard.test",
    });
    const handle = createDashboardAuthHttpHandler(httpAuth);
    await handle(
      new Request("http://dashboard.test/api/auth/magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "roles@example.com" }),
      }),
    );
    const loginToken = new URL(messages[0]!.magicLink).searchParams.get(
      "token",
    )!;
    const login = await handle(
      new Request(
        `http://dashboard.test/api/auth/magic-link?token=${loginToken}`,
      ),
    );
    const cookie = login.headers.get("set-cookie")!;
    const tenants = await handle(
      new Request("http://dashboard.test/api/tenants", { headers: { cookie } }),
    );
    const tenantBody = (await tenants.json()) as { tenants: unknown[] };
    expect(tenantBody.tenants).toHaveLength(3);
    const switched = await handle(
      new Request("http://dashboard.test/api/tenants/current", {
        method: "PUT",
        headers: { cookie },
        body: JSON.stringify({ tenantId: tenantIds[2] }),
      }),
    );
    expect(switched.status).toBe(200);
    const forbiddenSwitch = await handle(
      new Request("http://dashboard.test/api/tenants/current", {
        method: "PUT",
        headers: { cookie },
        body: JSON.stringify({ tenantId: tenantIds[3] }),
      }),
    );
    expect(forbiddenSwitch.status).toBe(403);
    const memberMutation = await authorizeTenantRequest(
      httpAuth,
      new Request("http://dashboard.test/api/config", { headers: { cookie } }),
      tenantIds[2]!,
      ["owner", "admin"],
    );
    expect(memberMutation).toBeInstanceOf(Response);
    expect((memberMutation as Response).status).toBe(403);
  });
});
