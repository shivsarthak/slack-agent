import type { TenantId } from "../tenant.ts";
import {
  decryptEnvelope,
  encryptEnvelope,
  type EncryptedEnvelope,
  type KeyProvider,
} from "./envelope.ts";

export type CredentialKind = "slack" | "openai" | "mcp";

export interface EncryptedCredentialRecord {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly kind: CredentialKind;
  readonly version: number;
  readonly envelope: EncryptedEnvelope;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly updatedAt: Date;
}

export interface CredentialPersistence {
  get(
    tenantId: TenantId,
    id: string,
  ): Promise<EncryptedCredentialRecord | undefined>;
  save(
    record: EncryptedCredentialRecord,
    expectedVersion?: number,
  ): Promise<void>;
}

export interface ActiveCredential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly secret: string;
  readonly version: number;
  readonly keyVersion: number;
  readonly expiresAt?: Date;
}

export interface CredentialMetadata {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly version: number;
  readonly keyVersion: number;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly updatedAt: Date;
}

function subject(kind: CredentialKind, id: string): string {
  return `credential:${kind}:${id}`;
}

export class CredentialVault {
  private readonly tenantId: TenantId;
  private readonly keys: KeyProvider;
  private readonly persistence: CredentialPersistence;

  constructor(
    tenantId: TenantId,
    keys: KeyProvider,
    persistence: CredentialPersistence,
  ) {
    this.tenantId = tenantId;
    this.keys = keys;
    this.persistence = persistence;
  }

  async store(input: {
    id: string;
    kind: CredentialKind;
    secret: string;
    expiresAt?: Date;
  }): Promise<void> {
    if (input.id.trim() === "")
      throw new Error("Credential id must not be empty");
    if (input.secret === "")
      throw new Error("Credential secret must not be empty");
    const previous = await this.persistence.get(this.tenantId, input.id);
    if (previous && previous.kind !== input.kind)
      throw new Error(`Credential ${input.id} is already ${previous.kind}`);
    await this.persistence.save(
      {
        tenantId: this.tenantId,
        id: input.id,
        kind: input.kind,
        version: (previous?.version ?? 0) + 1,
        envelope: await encryptEnvelope(
          this.keys,
          this.tenantId,
          subject(input.kind, input.id),
          input.secret,
        ),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        updatedAt: new Date(),
      },
      previous?.version,
    );
  }

  async read(id: string): Promise<ActiveCredential | undefined> {
    const record = await this.persistence.get(this.tenantId, id);
    if (!record || record.revokedAt) return undefined;
    return {
      id: record.id,
      kind: record.kind,
      secret: await decryptEnvelope(
        this.keys,
        this.tenantId,
        subject(record.kind, record.id),
        record.envelope,
      ),
      version: record.version,
      keyVersion: record.envelope.keyVersion,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    };
  }

  async inspect(id: string): Promise<CredentialMetadata | undefined> {
    const record = await this.persistence.get(this.tenantId, id);
    return record
      ? {
          id: record.id,
          kind: record.kind,
          version: record.version,
          keyVersion: record.envelope.keyVersion,
          ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
          ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
          updatedAt: record.updatedAt,
        }
      : undefined;
  }

  async rotateEncryption(id: string): Promise<void> {
    const record = await this.persistence.get(this.tenantId, id);
    if (!record || record.revokedAt)
      throw new Error(`Active credential ${id} not found`);
    const plaintext = await decryptEnvelope(
      this.keys,
      this.tenantId,
      subject(record.kind, id),
      record.envelope,
    );
    await this.persistence.save(
      {
        ...record,
        version: record.version + 1,
        envelope: await encryptEnvelope(
          this.keys,
          this.tenantId,
          subject(record.kind, id),
          plaintext,
        ),
        updatedAt: new Date(),
      },
      record.version,
    );
  }

  async revoke(id: string): Promise<void> {
    const record = await this.persistence.get(this.tenantId, id);
    if (!record || record.revokedAt) return;
    await this.persistence.save(
      {
        ...record,
        version: record.version + 1,
        revokedAt: new Date(),
        updatedAt: new Date(),
      },
      record.version,
    );
  }
}
