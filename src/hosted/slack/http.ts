import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Tenant } from "../../tenant.ts";

export interface SlackInstallation {
  tenant: Tenant;
  teamId: string;
  teamName: string;
  enterpriseId?: string;
  botUserId: string;
  encryptedBotToken: string;
}

export interface SlackHttpPersistence {
  saveState(state: string, tenant: Tenant, expiresAt: Date): Promise<void>;
  /** Atomically returns and removes an unexpired state. */
  consumeState(state: string): Promise<Tenant | undefined>;
  /** Must reject when the workspace is already bound to a different Tenant. */
  bindInstallation(installation: SlackInstallation): Promise<void>;
  tenantForTeam(teamId: string): Promise<Tenant | undefined>;
  /** Atomically creates both the replay claim and Job, or neither. */
  createJobOnce(
    key: string,
    expiresAt: Date,
    job: {
      tenant: Tenant;
      id: string;
      threadKey: string;
      request: string;
    },
  ): Promise<boolean>;
}

export interface SlackOAuthClient {
  authorizationUrl(input: { state: string }): string;
  exchange(code: string): Promise<{
    teamId: string;
    teamName: string;
    enterpriseId?: string;
    botUserId: string;
    botToken: string;
  }>;
}

export interface SlackHttpHandlerDeps {
  signingSecret: string;
  persistence: SlackHttpPersistence;
  oauth: SlackOAuthClient;
  resolveInstallingTenant(request: Request): Promise<Tenant | undefined>;
  protectToken(token: string, tenant: Tenant): Promise<string>;
  /** Must return an unguessable value; defaults to 256 bits from the OS CSPRNG. */
  randomId?: () => string;
  clock?: { now(): Date };
  /** A hosting adapter should connect this to its request-lifetime waitUntil primitive. */
  defer?: (task: Promise<void>) => void;
}

const text = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

function signatureIsValid(
  request: Request,
  body: string,
  secret: string,
  now: Date,
): boolean {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const supplied = request.headers.get("x-slack-signature");
  if (!timestamp || !supplied || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function defer(deps: SlackHttpHandlerDeps, task: Promise<void>): void {
  if (deps.defer) deps.defer(task);
  else void task.catch(() => undefined);
}

/** Framework-neutral hosted Slack routes. The raw request body is deliberately verified before parsing. */
export function createSlackHttpHandler(deps: SlackHttpHandlerDeps) {
  const clock = deps.clock ?? { now: () => new Date() };
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/slack/install") {
      const tenant = await deps.resolveInstallingTenant(request);
      if (!tenant) return text("Authentication required", 401);
      const state = deps.randomId?.() ?? randomBytes(32).toString("base64url");
      await deps.persistence.saveState(
        state,
        tenant,
        new Date(clock.now().getTime() + 10 * 60_000),
      );
      return Response.redirect(deps.oauth.authorizationUrl({ state }), 302);
    }

    if (request.method === "GET" && url.pathname === "/slack/oauth/callback") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return text("Invalid OAuth callback", 400);
      const tenant = await deps.persistence.consumeState(state);
      if (!tenant) return text("Invalid or expired OAuth state", 400);
      try {
        const grant = await deps.oauth.exchange(code);
        const installation: SlackInstallation = {
          tenant,
          teamId: grant.teamId,
          teamName: grant.teamName,
          botUserId: grant.botUserId,
          encryptedBotToken: await deps.protectToken(grant.botToken, tenant),
          ...(grant.enterpriseId === undefined
            ? {}
            : { enterpriseId: grant.enterpriseId }),
        };
        await deps.persistence.bindInstallation(installation);
        return text("Slack workspace installed");
      } catch {
        return text("Slack installation failed", 400);
      }
    }

    const events =
      request.method === "POST" && url.pathname === "/slack/events";
    const interactions =
      request.method === "POST" && url.pathname === "/slack/interactions";
    if (!events && !interactions) return text("Not found", 404);

    const body = await request.text();
    const receivedAt = clock.now();
    if (!signatureIsValid(request, body, deps.signingSecret, receivedAt))
      return text("Invalid Slack signature", 401);

    let payload: Record<string, any>;
    try {
      payload = events
        ? JSON.parse(body)
        : JSON.parse(new URLSearchParams(body).get("payload") ?? "");
    } catch {
      return text("Invalid Slack payload", 400);
    }

    if (events && payload.type === "url_verification")
      return text(
        typeof payload.challenge === "string" ? payload.challenge : "",
        200,
      );

    if (events && payload.event?.type !== "app_mention") return text("");

    // Claiming and persistence happen after the response is formed. This keeps Slack's
    // three-second acknowledgement budget independent of database and queue latency.
    defer(
      deps,
      enqueue(
        deps,
        payload,
        events ? "event" : "interaction",
        body,
        receivedAt,
      ),
    );
    return text("");
  };
}

/** Minimal Slack OAuth v2 adapter; callers can replace fetch in HTTP contract tests. */
export function createSlackOAuthClient(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
  fetch?: typeof globalThis.fetch;
}): SlackOAuthClient {
  const request = input.fetch ?? globalThis.fetch;
  return {
    authorizationUrl({ state }) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("scope", input.scopes.join(","));
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code) {
      const response = await request("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code,
          redirect_uri: input.redirectUri,
        }),
      });
      const value: any = await response.json();
      if (
        !response.ok ||
        value.ok !== true ||
        typeof value.team?.id !== "string" ||
        typeof value.team?.name !== "string" ||
        typeof value.bot_user_id !== "string" ||
        typeof value.access_token !== "string"
      )
        throw new Error(
          `Slack OAuth exchange failed: ${String(value.error ?? response.status)}`,
        );
      return {
        teamId: value.team.id,
        teamName: value.team.name,
        botUserId: value.bot_user_id,
        botToken: value.access_token,
        ...(typeof value.enterprise?.id === "string"
          ? { enterpriseId: value.enterprise.id }
          : {}),
      };
    },
  };
}

async function enqueue(
  deps: SlackHttpHandlerDeps,
  payload: Record<string, any>,
  kind: "event" | "interaction",
  rawBody: string,
  receivedAt: Date,
): Promise<void> {
  const teamId = kind === "event" ? payload.team_id : payload.team?.id;
  if (typeof teamId !== "string") return;
  const tenant = await deps.persistence.tenantForTeam(teamId);
  if (!tenant) return;

  const event = kind === "event" ? payload.event : payload;
  const id =
    (kind === "event" ? payload.event_id : payload.trigger_id) ??
    createHash("sha256").update(rawBody).digest("hex");
  if (typeof id !== "string") return;
  const channel = event?.channel?.id ?? event?.channel;
  const timestamp =
    event?.message?.thread_ts ??
    event?.message?.ts ??
    event?.thread_ts ??
    event?.ts;
  const request =
    kind === "event"
      ? event?.text
      : (event?.actions?.[0]?.value ?? event?.actions?.[0]?.action_id);
  if (
    typeof channel !== "string" ||
    typeof timestamp !== "string" ||
    typeof request !== "string"
  )
    return;
  await deps.persistence.createJobOnce(
    `${kind}:${teamId}:${id}`,
    new Date(receivedAt.getTime() + 24 * 60 * 60_000),
    {
      tenant,
      id,
      threadKey: `${channel}:${timestamp}`,
      request,
    },
  );
}
