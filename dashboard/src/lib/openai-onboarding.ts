import type { KeyProvider } from "@agent/credentials/envelope.ts";
import { CredentialVault } from "@agent/credentials/vault.ts";
import { postgresOnboardingPersistence } from "@agent/hosted/postgres/openai-onboarding.ts";
import { postgresCredentialPersistence } from "@agent/hosted/postgres/secrets.ts";
import {
  OpenAICodexOnboarding,
  type OpenAICodexAuthAdapter,
} from "@agent/openai/onboarding.ts";
import { createOpenAICodexOnboardingHttpHandler } from "@agent/openai/http.ts";
import { loadPiOpenAICodexAuthAdapter } from "@agent/openai/pi-auth.ts";
import { tenantId } from "@agent/tenant.ts";
import { authorizeTenantRequest } from "@agent/dashboard/auth.ts";
import { dashboardAuth, dashboardPool } from "./hosted-auth";

const services = new Map<string, OpenAICodexOnboarding>();
let piAdapter: Promise<OpenAICodexAuthAdapter> | undefined;

const lazyPiAdapter: OpenAICodexAuthAdapter = {
  async login(input) {
    piAdapter ??= loadPiOpenAICodexAuthAdapter();
    return (await piAdapter).login(input);
  },
  async refresh(credential, signal) {
    piAdapter ??= loadPiOpenAICodexAuthAdapter();
    return (await piAdapter).refresh(credential, signal);
  },
};

function encryptionKeys(): KeyProvider {
  const encoded = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const version = Number(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION ?? "1");
  if (!encoded) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 bytes");
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY_VERSION must be positive");
  return {
    async currentVersion() {
      return version;
    },
    async key(requested) {
      if (requested !== version)
        throw new Error(`Encryption key version ${requested} is unavailable`);
      return key;
    },
  };
}

function forTenant(id: string): OpenAICodexOnboarding {
  const existing = services.get(id);
  if (existing) return existing;
  const owner = tenantId(id);
  const created = new OpenAICodexOnboarding({
    tenantId: owner,
    attempts: postgresOnboardingPersistence(dashboardPool),
    vault: new CredentialVault(
      owner,
      encryptionKeys(),
      postgresCredentialPersistence(dashboardPool),
    ),
    adapter: lazyPiAdapter,
  });
  services.set(id, created);
  return created;
}

export const handleOpenAICodexOnboarding =
  createOpenAICodexOnboardingHttpHandler({
    async authorize(request, owner, roles) {
      const result = await authorizeTenantRequest(
        dashboardAuth,
        request,
        owner,
        roles,
      );
      return result instanceof Response ? result : { userId: result.user.id };
    },
    forTenant,
  });
