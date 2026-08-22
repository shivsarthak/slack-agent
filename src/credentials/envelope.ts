import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TenantId } from "../tenant.ts";

export interface KeyProvider {
  currentVersion(): Promise<number>;
  key(version: number): Promise<Uint8Array>;
}

export interface EncryptedEnvelope {
  readonly algorithm: "A256GCM";
  readonly keyVersion: number;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function associatedData(tenantId: TenantId, subject: string): Buffer {
  return Buffer.from(`open-agent:v1\0${tenantId}\0${subject}`, "utf8");
}

function encryptionKey(bytes: Uint8Array): Buffer {
  if (bytes.byteLength !== 32)
    throw new Error("AES-256-GCM keys must be exactly 32 bytes");
  return Buffer.from(bytes);
}

export async function encryptEnvelope(
  keys: KeyProvider,
  tenantId: TenantId,
  subject: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const keyVersion = await keys.currentVersion();
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1)
    throw new Error("Key versions must be positive integers");
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(await keys.key(keyVersion)),
    iv,
  );
  cipher.setAAD(associatedData(tenantId, subject));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "A256GCM",
    keyVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export async function decryptEnvelope(
  keys: KeyProvider,
  tenantId: TenantId,
  subject: string,
  envelope: EncryptedEnvelope,
): Promise<string> {
  try {
    if (envelope.algorithm !== "A256GCM")
      throw new Error("unsupported algorithm");
    if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1)
      throw new Error("invalid key version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(await keys.key(envelope.keyVersion)),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(associatedData(tenantId, subject));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Credential envelope could not be decrypted", {
      cause: error,
    });
  }
}
