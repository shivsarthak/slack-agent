import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  type KeyProvider,
} from "../../src/credentials/envelope.ts";
import { tenantId } from "../../src/tenant.ts";

const keys = new Map([
  [1, Uint8Array.from({ length: 32 }, (_, index) => index)],
  [2, Uint8Array.from({ length: 32 }, (_, index) => 255 - index)],
]);

const provider: KeyProvider = {
  async currentVersion() {
    return 2;
  },
  async key(version) {
    const key = keys.get(version);
    if (!key) throw new Error(`Unknown key version ${version}`);
    return key;
  },
};

describe("AES-256-GCM credential envelopes", () => {
  it("round-trips with explicit key-version metadata without exposing plaintext", async () => {
    const tenant = tenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const envelope = await encryptEnvelope(
      provider,
      tenant,
      "openai:primary",
      "sk-secret-value",
    );

    expect(envelope.keyVersion).toBe(2);
    expect(JSON.stringify(envelope)).not.toContain("sk-secret-value");
    await expect(
      decryptEnvelope(provider, tenant, "openai:primary", envelope),
    ).resolves.toBe("sk-secret-value");
  });

  it("rejects tampering and use by another Tenant", async () => {
    const alpha = tenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const beta = tenantId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const envelope = await encryptEnvelope(
      provider,
      alpha,
      "slack:bot",
      "xoxb-secret",
    );
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    await expect(
      decryptEnvelope(provider, alpha, "slack:bot", {
        ...envelope,
        ciphertext: ciphertext.toString("base64url"),
      }),
    ).rejects.toThrow(/decrypt/i);
    await expect(
      decryptEnvelope(provider, beta, "slack:bot", envelope),
    ).rejects.toThrow(/decrypt/i);
  });
});
