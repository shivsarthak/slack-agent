import { describe, expect, it } from "vitest";
import type { KeyProvider } from "../src/credentials/envelope.ts";
import {
  OpenAICodexOnboarding,
  type DeviceLoginNotice,
  type OpenAICodexAuthAdapter,
  type OpenAICodexCredential,
  type OnboardingAttempt,
  type OnboardingPersistence,
} from "../src/openai/onboarding.ts";
import {
  CredentialVault,
  type CredentialPersistence,
  type EncryptedCredentialRecord,
} from "../src/credentials/vault.ts";
import { tenantId, type TenantId } from "../src/tenant.ts";
import { createPiOpenAICodexAuthAdapter } from "../src/openai/pi-auth.ts";
import { createOpenAICodexOnboardingHttpHandler } from "../src/openai/http.ts";

class MemoryAttempts implements OnboardingPersistence {
  readonly attempts = new Map<string, OnboardingAttempt>();

  async active(tenant: TenantId) {
    return [...this.attempts.values()].find(
      (attempt) => attempt.tenantId === tenant && attempt.status === "pending",
    );
  }

  async create(record: OnboardingAttempt) {
    const active = await this.active(record.tenantId);
    if (active) return active;
    this.attempts.set(record.id, record);
    return record;
  }

  async get(tenant: TenantId, id: string) {
    const attempt = this.attempts.get(id);
    return attempt?.tenantId === tenant ? attempt : undefined;
  }

  async update(
    record: OnboardingAttempt,
    expectedStatus: OnboardingAttempt["status"],
  ) {
    const current = this.attempts.get(record.id);
    if (!current || current.status !== expectedStatus) return false;
    this.attempts.set(record.id, record);
    return true;
  }
}

class MemoryCredentials implements CredentialPersistence {
  readonly records = new Map<string, EncryptedCredentialRecord>();
  async get(tenant: TenantId, id: string) {
    return this.records.get(`${tenant}:${id}`);
  }
  async save(record: EncryptedCredentialRecord) {
    this.records.set(`${record.tenantId}:${record.id}`, record);
  }
}

const keys: KeyProvider = {
  async currentVersion() {
    return 1;
  },
  async key() {
    return new Uint8Array(32).fill(9);
  },
};

function credential(
  suffix: string,
  expires = Date.parse("2026-09-01T00:00:00Z"),
): OpenAICodexCredential {
  return {
    type: "oauth",
    access: `access-${suffix}`,
    refresh: `refresh-${suffix}`,
    expires,
    accountId: `account-${suffix}`,
  };
}

function deferredAdapter() {
  let notice: ((event: DeviceLoginNotice) => void) | undefined;
  let resolve: ((value: OpenAICodexCredential) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  let signal: AbortSignal | undefined;
  const adapter: OpenAICodexAuthAdapter = {
    login(input) {
      notice = input.onDeviceCode;
      signal = input.signal;
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
    async refresh() {
      return credential("refreshed");
    },
  };
  return {
    adapter,
    device(event: DeviceLoginNotice) {
      notice!(event);
    },
    succeed(value = credential("initial")) {
      resolve!(value);
    },
    fail(error = new Error("provider failed with access-secret")) {
      reject!(error);
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}

function setup(adapter: OpenAICodexAuthAdapter) {
  const attempts = new MemoryAttempts();
  const credentials = new MemoryCredentials();
  const tenant = tenantId("alpha");
  const vault = new CredentialVault(tenant, keys, credentials);
  const onboarding = new OpenAICodexOnboarding({
    tenantId: tenant,
    attempts,
    vault,
    adapter,
    now: () => new Date("2026-08-23T00:00:00Z"),
    newId: () => "attempt-1",
  });
  return { attempts, credentials, onboarding, tenant, vault };
}

describe("OpenAI Codex onboarding public seam", () => {
  it("returns one deterministic active attempt and exposes only device presentation", async () => {
    const pi = deferredAdapter();
    const { onboarding } = setup(pi.adapter);

    const first = await onboarding.initiate("admin-1");
    const concurrent = await onboarding.initiate("admin-2");
    expect(concurrent.id).toBe(first.id);
    expect(concurrent.initiatedByUserId).toBe("admin-1");

    pi.device({
      verificationUrl: "https://auth.openai.test/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 900,
    });
    await expect
      .poll(() => onboarding.status(first.id))
      .toMatchObject({
        status: "pending",
        verificationUrl: "https://auth.openai.test/device",
        userCode: "ABCD-EFGH",
        expiresAt: new Date("2026-08-23T00:15:00Z"),
      });
  });

  it("encrypts success for the initiating Tenant and never returns or persists plaintext secrets", async () => {
    const pi = deferredAdapter();
    const { onboarding, credentials, vault } = setup(pi.adapter);
    const attempt = await onboarding.initiate("admin-1");
    pi.device({
      verificationUrl: "https://auth.openai.test/device",
      userCode: "SAFE-CODE",
      expiresInSeconds: 900,
    });
    pi.succeed();
    await expect
      .poll(async () => (await onboarding.status(attempt.id))?.status)
      .toBe("connected");

    expect(JSON.stringify([...credentials.records.values()])).not.toMatch(
      /access-initial|refresh-initial/,
    );
    await expect(vault.read("openai-codex")).resolves.toMatchObject({
      kind: "openai",
    });
    const publicStatus = await onboarding.status(attempt.id);
    expect(JSON.stringify(publicStatus)).not.toMatch(
      /access-initial|refresh-initial|account-initial/,
    );
    await expect(
      new CredentialVault(tenantId("other"), keys, credentials).read(
        "openai-codex",
      ),
    ).resolves.toBeUndefined();
  });

  it("supports cancellation and redacts provider failures", async () => {
    const cancelledPi = deferredAdapter();
    const { onboarding } = setup(cancelledPi.adapter);
    const attempt = await onboarding.initiate("owner-1");
    await onboarding.cancel(attempt.id);
    expect(cancelledPi.aborted).toBe(true);
    await expect(onboarding.status(attempt.id)).resolves.toMatchObject({
      status: "cancelled",
    });

    const failedPi = deferredAdapter();
    const failed = setup(failedPi.adapter).onboarding;
    const failedAttempt = await failed.initiate("owner-1");
    failedPi.fail();
    await expect
      .poll(async () => (await failed.status(failedAttempt.id))?.status)
      .toBe("failed");
    expect(JSON.stringify(await failed.status(failedAttempt.id))).not.toContain(
      "access-secret",
    );
  });

  it("refreshes, reports expiry, and revokes the one Tenant credential", async () => {
    const pi = deferredAdapter();
    const { onboarding } = setup(pi.adapter);
    const attempt = await onboarding.initiate("admin-1");
    pi.succeed(credential("initial", Date.parse("2026-08-24T00:00:00Z")));
    await expect
      .poll(async () => (await onboarding.status(attempt.id))?.status)
      .toBe("connected");

    await expect(onboarding.credentialStatus()).resolves.toMatchObject({
      status: "connected",
      expiresAt: new Date("2026-08-24T00:00:00Z"),
    });
    await onboarding.refresh();
    await expect(onboarding.credentialStatus()).resolves.toMatchObject({
      status: "connected",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    });
    await onboarding.revoke();
    await expect(onboarding.credentialStatus()).resolves.toMatchObject({
      status: "revoked",
    });
  });
});

describe("Pi auth adapter contract", () => {
  it("selects Pi's device flow, forwards presentation, refreshes, and honors cancellation", async () => {
    const selected: string[] = [];
    const controller = new AbortController();
    const pi = {
      async login(interaction: {
        signal: AbortSignal;
        prompt(input: { type: string }): Promise<string>;
        notify(event: unknown): void;
      }) {
        selected.push(await interaction.prompt({ type: "select" }));
        interaction.notify({
          type: "device_code",
          verificationUri: "https://auth.openai.test/device",
          userCode: "PI-CODE",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        expect(interaction.signal).toBe(controller.signal);
        return credential("pi");
      },
      async refresh(current: OpenAICodexCredential, signal: AbortSignal) {
        expect(current.refresh).toBe("refresh-pi");
        expect(signal.aborted).toBe(false);
        return credential("new-pi");
      },
    };
    const adapter = createPiOpenAICodexAuthAdapter(pi);
    const notices: DeviceLoginNotice[] = [];
    await expect(
      adapter.login({
        signal: controller.signal,
        onDeviceCode: (event) => notices.push(event),
      }),
    ).resolves.toMatchObject({ access: "access-pi" });
    expect(selected).toEqual(["device_code"]);
    expect(notices).toEqual([
      {
        verificationUrl: "https://auth.openai.test/device",
        userCode: "PI-CODE",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    ]);
    await expect(
      adapter.refresh(credential("pi"), new AbortController().signal),
    ).resolves.toMatchObject({ access: "access-new-pi" });
  });
});

describe("OpenAI Codex onboarding HTTP seam", () => {
  it("allows only owner/admin initiation and revocation and never serializes credentials", async () => {
    const pi = deferredAdapter();
    const { onboarding } = setup(pi.adapter);
    let role: "owner" | "admin" | "member" = "member";
    const handle = createOpenAICodexOnboardingHttpHandler({
      authorize: async (_request, tenant, allowed) =>
        tenant === "alpha" && allowed.includes(role)
          ? { userId: "user-1" }
          : new Response(JSON.stringify({ error: "forbidden" }), {
              status: 403,
            }),
      forTenant: () => onboarding,
    });
    const endpoint = "http://dashboard.test/api/tenants/alpha/openai-codex";

    expect(
      (await handle(new Request(`${endpoint}/onboarding`, { method: "POST" })))
        .status,
    ).toBe(403);
    role = "admin";
    const started = await handle(
      new Request(`${endpoint}/onboarding`, { method: "POST" }),
    );
    expect(started.status).toBe(202);
    const attempt = (await started.json()) as { id: string };
    pi.succeed();
    await expect
      .poll(
        async () =>
          (
            (await (
              await handle(new Request(`${endpoint}/onboarding/${attempt.id}`))
            ).json()) as { status: string }
          ).status,
      )
      .toBe("connected");
    expect(
      JSON.stringify(
        await (await handle(new Request(`${endpoint}/credential`))).json(),
      ),
    ).not.toMatch(/access-initial|refresh-initial|account-initial/);

    role = "member";
    expect(
      (
        await handle(
          new Request(`${endpoint}/credential`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(403);
    role = "owner";
    const revoked = await handle(
      new Request(`${endpoint}/credential`, { method: "DELETE" }),
    );
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
  });
});
