import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TenantRole = "owner" | "admin" | "member";
export interface MailMessage {
  to: string;
  magicLink: string;
  expiresAt: Date;
}
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}
export interface Clock {
  now(): Date;
}
export interface DashboardSession {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string; displayName?: string };
}
export interface TenantAccess {
  id: string;
  name: string;
  role: TenantRole;
}

export class DevelopmentMailSink implements MailPort {
  readonly messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function token(): string {
  return randomBytes(32).toString("base64url");
}
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createDashboardAuth(input: {
  pool: Pool;
  mail: MailPort;
  publicUrl: string;
  clock?: Clock;
}) {
  const clock = input.clock ?? { now: () => new Date() };

  async function createSession(
    client: Pool | PoolClient,
    user: { id: string; email: string; display_name: string | null },
  ): Promise<DashboardSession> {
    const raw = token();
    const expiresAt = new Date(clock.now().getTime() + SESSION_TTL_MS);
    await client.query(
      "insert into dashboard_sessions (token_hash, user_id, expires_at, created_at) values ($1, $2, $3, $4)",
      [hash(raw), user.id, expiresAt, clock.now()],
    );
    return {
      token: raw,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        ...(user.display_name ? { displayName: user.display_name } : {}),
      },
    };
  }

  return {
    async requestMagicLink(emailInput: string): Promise<void> {
      const email = normalizeEmail(emailInput);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("invalid email");
      const raw = token();
      const expiresAt = new Date(clock.now().getTime() + MAGIC_LINK_TTL_MS);
      await input.pool.query(
        "insert into dashboard_magic_links (token_hash, email, expires_at, created_at) values ($1, $2, $3, $4)",
        [hash(raw), email, expiresAt, clock.now()],
      );
      const url = new URL("/api/auth/magic-link", input.publicUrl);
      url.searchParams.set("token", raw);
      await input.mail.send({
        to: email,
        magicLink: url.toString(),
        expiresAt,
      });
    },

    async consumeMagicLink(raw: string): Promise<DashboardSession | undefined> {
      const client = await input.pool.connect();
      try {
        await client.query("begin");
        const consumed = await client.query<{ email: string }>(
          `update dashboard_magic_links set used_at = $2
           where token_hash = $1 and used_at is null and expires_at > $2
           returning email`,
          [hash(raw), clock.now()],
        );
        const email = consumed.rows[0]?.email;
        if (!email) {
          await client.query("rollback");
          return undefined;
        }
        const userResult = await client.query<{
          id: string;
          email: string;
          display_name: string | null;
        }>(
          `insert into users (id, email) values ($1, $2)
           on conflict (email) do update set email = excluded.email
           returning id, email, display_name`,
          [randomUUID(), email],
        );
        const session = await createSession(client, userResult.rows[0]!);
        await client.query("commit");
        return session;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async authenticate(
      raw: string | undefined,
    ): Promise<DashboardSession["user"] | undefined> {
      if (!raw) return undefined;
      const result = await input.pool.query<{
        id: string;
        email: string;
        display_name: string | null;
      }>(
        `select u.id, u.email, u.display_name
         from dashboard_sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.revoked_at is null and s.rotated_at is null and s.expires_at > $2`,
        [hash(raw), clock.now()],
      );
      const user = result.rows[0];
      return user
        ? {
            id: user.id,
            email: user.email,
            ...(user.display_name ? { displayName: user.display_name } : {}),
          }
        : undefined;
    },

    async rotateSession(raw: string): Promise<DashboardSession | undefined> {
      const client = await input.pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{
          id: string;
          email: string;
          display_name: string | null;
        }>(
          `update dashboard_sessions s set rotated_at = $2
           from users u where s.token_hash = $1 and u.id = s.user_id
           and s.revoked_at is null and s.rotated_at is null and s.expires_at > $2
           returning u.id, u.email, u.display_name`,
          [hash(raw), clock.now()],
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return undefined;
        }
        const session = await createSession(client, result.rows[0]);
        await client.query("commit");
        return session;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async logout(raw: string | undefined): Promise<void> {
      if (raw) {
        await input.pool.query(
          "update dashboard_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null",
          [hash(raw), clock.now()],
        );
      }
    },

    async listTenants(userId: string): Promise<TenantAccess[]> {
      const result = await input.pool.query<TenantAccess>(
        `select t.id, t.name, m.role from memberships m
         join tenants t on t.id = m.tenant_id where m.user_id = $1 order by t.name, t.id`,
        [userId],
      );
      return result.rows;
    },

    async authorize(
      userId: string,
      tenantId: string,
      allowed: readonly TenantRole[],
    ): Promise<TenantAccess | undefined> {
      const result = await input.pool.query<TenantAccess>(
        `select t.id, t.name, m.role from memberships m
         join tenants t on t.id = m.tenant_id
         where m.user_id = $1 and m.tenant_id = $2 and m.role = any($3::text[])`,
        [userId, tenantId, allowed],
      );
      return result.rows[0];
    },
  };
}

export type DashboardAuth = ReturnType<typeof createDashboardAuth>;

export const DASHBOARD_SESSION_COOKIE = "oa_dashboard_session";
export const DASHBOARD_TENANT_COOKIE = "oa_dashboard_tenant";

function cookieToken(request: Request): string | undefined {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === DASHBOARD_SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

function sessionCookie(session: DashboardSession, secure: boolean): string {
  return `${DASHBOARD_SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? "; Secure" : ""}`;
}

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

/** Framework-neutral public HTTP seam, shared by Next.js and integration tests. */
export function createDashboardAuthHttpHandler(auth: DashboardAuth) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    if (url.pathname === "/api/auth/magic-link" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as
        | { email?: unknown }
        | undefined;
      if (typeof body?.email !== "string")
        return json({ error: "invalid email" }, 400);
      try {
        await auth.requestMagicLink(body.email);
      } catch {
        return json({ error: "invalid email" }, 400);
      }
      // Deliberately does not disclose whether an account already exists.
      return json({ ok: true }, 202);
    }
    if (url.pathname === "/api/auth/magic-link" && request.method === "GET") {
      const raw = url.searchParams.get("token");
      const session = raw ? await auth.consumeMagicLink(raw) : undefined;
      return session
        ? new Response(null, {
            status: 303,
            headers: {
              location: "/",
              "set-cookie": sessionCookie(session, secure),
              "cache-control": "no-store",
            },
          })
        : json({ error: "invalid or expired link" }, 401, {
            "cache-control": "no-store",
          });
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const user = await auth.authenticate(cookieToken(request));
      return user
        ? json({ user }, 200, { "cache-control": "no-store" })
        : json({ error: "unauthenticated" }, 401);
    }
    if (url.pathname === "/api/auth/session" && request.method === "POST") {
      const raw = cookieToken(request);
      const session = raw ? await auth.rotateSession(raw) : undefined;
      return session
        ? json({ user: session.user }, 200, {
            "set-cookie": sessionCookie(session, secure),
            "cache-control": "no-store",
          })
        : json({ error: "unauthenticated" }, 401);
    }
    if (url.pathname === "/api/auth/session" && request.method === "DELETE") {
      await auth.logout(cookieToken(request));
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/api/tenants" && request.method === "GET") {
      const user = await auth.authenticate(cookieToken(request));
      return user
        ? json({ tenants: await auth.listTenants(user.id) })
        : json({ error: "unauthenticated" }, 401);
    }
    if (url.pathname === "/api/tenants/current" && request.method === "PUT") {
      const user = await auth.authenticate(cookieToken(request));
      if (!user) return json({ error: "unauthenticated" }, 401);
      const body = (await request.json().catch(() => undefined)) as
        | { tenantId?: unknown }
        | undefined;
      if (typeof body?.tenantId !== "string")
        return json({ error: "invalid tenant" }, 400);
      const tenant = await auth.authorize(user.id, body.tenantId, [
        "owner",
        "admin",
        "member",
      ]);
      return tenant
        ? json({ tenant }, 200, {
            "set-cookie": `${DASHBOARD_TENANT_COOKIE}=${encodeURIComponent(tenant.id)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
            "cache-control": "no-store",
          })
        : json({ error: "forbidden" }, 403);
    }
    return json({ error: "not found" }, 404);
  };
}

export async function authorizeTenantRequest(
  auth: DashboardAuth,
  request: Request,
  tenantId: string,
  allowed: readonly TenantRole[],
): Promise<
  { user: DashboardSession["user"]; tenant: TenantAccess } | Response
> {
  const user = await auth.authenticate(cookieToken(request));
  if (!user) return json({ error: "unauthenticated" }, 401);
  const tenant = await auth.authorize(user.id, tenantId, allowed);
  // A non-member sees the same response as a member lacking the necessary role.
  if (!tenant) return json({ error: "forbidden" }, 403);
  return { user, tenant };
}
