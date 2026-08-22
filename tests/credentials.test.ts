import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  type EncryptedCredentialRecord,
  type CredentialPersistence,
} from "../src/credentials/vault.ts";
import type { KeyProvider } from "../src/credentials/envelope.ts";
import { tenantId, type TenantId } from "../src/tenant.ts";

class MemoryCredentials implements CredentialPersistence {
  readonly records = new Map<string, EncryptedCredentialRecord>();
  async get(tenant: TenantId, id: string) {
    return this.records.get(`${tenant}:${id}`);
  }
  async save(record: EncryptedCredentialRecord) {
    this.records.set(`${record.tenantId}:${record.id}`, record);
  }
}

function rotatingKeys() {
  let version = 1;
  const keys = new Map<number, Uint8Array>([[1, new Uint8Array(32).fill(1)]]);
  const provider: KeyProvider = {
    async currentVersion() {
      return version;
    },
    async key(requested) {
      const key = keys.get(requested);
      if (!key) throw new Error("missing key");
      return key;
    },
  };
  return {
    provider,
    rotate() {
      version += 1;
      keys.set(version, new Uint8Array(32).fill(version));
    },
  };
}

describe("Tenant credential vault", () => {
  it("stores Slack, OpenAI, and MCP credentials encrypted and isolated", async () => {
    const persistence = new MemoryCredentials();
    const keys = rotatingKeys();
    const alpha = new CredentialVault(
      tenantId("alpha"),
      keys.provider,
      persistence,
    );
    const beta = new CredentialVault(
      tenantId("beta"),
      keys.provider,
      persistence,
    );

    await alpha.store({ id: "slack", kind: "slack", secret: "xoxb-alpha" });
    await alpha.store({ id: "openai", kind: "openai", secret: "sk-alpha" });
    await alpha.store({ id: "github", kind: "mcp", secret: "ghp-alpha" });

    expect(JSON.stringify([...persistence.records.values()])).not.toMatch(
      /xoxb-alpha|sk-alpha|ghp-alpha/,
    );
    await expect(alpha.read("slack")).resolves.toMatchObject({
      kind: "slack",
      secret: "xoxb-alpha",
      version: 1,
    });
    await expect(beta.read("slack")).resolves.toBeUndefined();
  });

  it("rotates encryption keys without losing active credentials and makes revoked credentials unavailable", async () => {
    const persistence = new MemoryCredentials();
    const keys = rotatingKeys();
    const vault = new CredentialVault(
      tenantId("alpha"),
      keys.provider,
      persistence,
    );
    await vault.store({ id: "openai", kind: "openai", secret: "sk-active" });

    keys.rotate();
    await vault.rotateEncryption("openai");
    await expect(vault.read("openai")).resolves.toMatchObject({
      secret: "sk-active",
      keyVersion: 2,
    });

    await vault.revoke("openai");
    await expect(vault.read("openai")).resolves.toBeUndefined();
  });
});
