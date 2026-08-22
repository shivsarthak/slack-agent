import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tenantId, type Tenant } from "../src/tenant.ts";
import {
  createSlackHttpHandler,
  type SlackHttpPersistence,
} from "../src/hosted/slack/http.ts";

const tenant: Tenant = { id: tenantId("11111111-1111-4111-8111-111111111111") };
const now = new Date("2026-08-22T10:00:00.000Z");

function signed(body: string, timestamp = String(now.getTime() / 1000)) {
  const signature = `v0=${createHmac("sha256", "signing-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

function harness() {
  const states = new Map<string, Tenant>();
  const teams = new Map<string, Tenant>();
  const claimed = new Set<string>();
  const installations: unknown[] = [];
  const jobs: unknown[] = [];
  const pending: Promise<void>[] = [];
  const persistence: SlackHttpPersistence = {
    async saveState(state, value) {
      states.set(state, value);
    },
    async consumeState(state) {
      const value = states.get(state);
      states.delete(state);
      return value;
    },
    async bindInstallation(value) {
      teams.set(value.teamId, value.tenant);
      installations.push(value);
    },
    async tenantForTeam(teamId) {
      return teams.get(teamId);
    },
    async createJobOnce(key, _expiresAt, value) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      jobs.push(value);
      return true;
    },
  };
  let sequence = 0;
  const handler = createSlackHttpHandler({
    signingSecret: "signing-secret",
    clock: { now: () => now },
    persistence,
    resolveInstallingTenant: async () => tenant,
    oauth: {
      authorizationUrl: ({ state }) =>
        `https://slack.test/oauth?state=${state}`,
      async exchange(code) {
        expect(code).toBe("oauth-code");
        return {
          teamId: "T1",
          teamName: "Acme",
          botUserId: "B1",
          botToken: "xoxb-secret",
        };
      },
    },
    protectToken: async (token) => `encrypted:${token}`,
    randomId: () => `id-${++sequence}`,
    defer(task) {
      pending.push(task);
    },
  });
  return { handler, installations, jobs, pending, persistence };
}

describe("hosted Slack HTTP contract", () => {
  it("binds an OAuth callback to the one Tenant captured by single-use state", async () => {
    const app = harness();
    const install = await app.handler(
      new Request("https://agent.test/slack/install"),
    );
    const state = new URL(install.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await app.handler(
      new Request(
        `https://agent.test/slack/oauth/callback?code=oauth-code&state=${state}`,
      ),
    );
    expect(callback.status).toBe(200);
    expect(app.installations).toEqual([
      {
        tenant,
        teamId: "T1",
        teamName: "Acme",
        botUserId: "B1",
        encryptedBotToken: "encrypted:xoxb-secret",
      },
    ]);
    const replay = await app.handler(
      new Request(
        `https://agent.test/slack/oauth/callback?code=oauth-code&state=${state}`,
      ),
    );
    expect(replay.status).toBe(400);
  });

  it("rejects invalid and stale signatures without enqueuing work", async () => {
    const app = harness();
    const body = JSON.stringify({
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "app_mention", channel: "C1", ts: "1.2", text: "hello" },
    });
    for (const headers of [
      { ...signed(body), "x-slack-signature": "v0=bad" },
      signed(body, String(now.getTime() / 1000 - 301)),
    ]) {
      const response = await app.handler(
        new Request("https://agent.test/slack/events", {
          method: "POST",
          headers,
          body,
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(app.jobs).toEqual([]);
  });

  it("acknowledges immediately and creates only one Tenant-scoped Job for retries", async () => {
    const app = harness();
    await app.persistence.bindInstallation({
      tenant,
      teamId: "T1",
      teamName: "Acme",
      botUserId: "B1",
      encryptedBotToken: "cipher",
    });
    const body = JSON.stringify({
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1.2",
        text: "<@B1> investigate",
      },
    });
    const request = () =>
      new Request("https://agent.test/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...signed(body) },
        body,
      });
    expect((await app.handler(request())).status).toBe(200);
    await Promise.all(app.pending);
    expect((await app.handler(request())).status).toBe(200);
    await Promise.all(app.pending);
    expect(app.jobs).toEqual([
      { tenant, id: "Ev1", threadKey: "C1:1.2", request: "<@B1> investigate" },
    ]);
  });

  it("validates and acknowledges interaction payloads through the same signed ingress", async () => {
    const app = harness();
    await app.persistence.bindInstallation({
      tenant,
      teamId: "T1",
      teamName: "Acme",
      botUserId: "B1",
      encryptedBotToken: "cipher",
    });
    const payload = JSON.stringify({
      team: { id: "T1" },
      trigger_id: "trigger-1",
      channel: { id: "C2" },
      message: { ts: "2.3" },
      actions: [{ action_id: "do_work", value: "ship it" }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const response = await app.handler(
      new Request("https://agent.test/slack/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...signed(body),
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
    await Promise.all(app.pending);
    expect(app.jobs).toEqual([
      { tenant, id: "trigger-1", threadKey: "C2:2.3", request: "ship it" },
    ]);
  });
});
