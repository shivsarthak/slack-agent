import type { TenantId } from "../tenant.ts";
import {
  tenantConfigurationSchema,
  type TenantConfiguration,
} from "../tenant-configuration.ts";
import {
  decryptEnvelope,
  encryptEnvelope,
  type EncryptedEnvelope,
  type KeyProvider,
} from "./envelope.ts";

export interface EncryptedConfigurationRecord {
  readonly tenantId: TenantId;
  readonly version: number;
  readonly envelope: EncryptedEnvelope;
  readonly updatedAt: Date;
}

export interface ConfigurationPersistence {
  get(tenantId: TenantId): Promise<EncryptedConfigurationRecord | undefined>;
  save(
    record: EncryptedConfigurationRecord,
    expectedVersion?: number,
  ): Promise<void>;
}

export class TenantConfigurationVault {
  private readonly tenantId: TenantId;
  private readonly keys: KeyProvider;
  private readonly persistence: ConfigurationPersistence;

  constructor(
    tenantId: TenantId,
    keys: KeyProvider,
    persistence: ConfigurationPersistence,
  ) {
    this.tenantId = tenantId;
    this.keys = keys;
    this.persistence = persistence;
  }

  async store(configuration: TenantConfiguration): Promise<number> {
    const valid = tenantConfigurationSchema.parse(configuration);
    const previous = await this.persistence.get(this.tenantId);
    const version = (previous?.version ?? 0) + 1;
    await this.persistence.save(
      {
        tenantId: this.tenantId,
        version,
        envelope: await encryptEnvelope(
          this.keys,
          this.tenantId,
          "configuration",
          JSON.stringify(valid),
        ),
        updatedAt: new Date(),
      },
      previous?.version,
    );
    return version;
  }

  async read(): Promise<
    | {
        configuration: TenantConfiguration;
        version: number;
        keyVersion: number;
      }
    | undefined
  > {
    const record = await this.persistence.get(this.tenantId);
    if (!record) return undefined;
    const plaintext = await decryptEnvelope(
      this.keys,
      this.tenantId,
      "configuration",
      record.envelope,
    );
    return {
      configuration: tenantConfigurationSchema.parse(JSON.parse(plaintext)),
      version: record.version,
      keyVersion: record.envelope.keyVersion,
    };
  }

  async rotateEncryption(): Promise<void> {
    const active = await this.read();
    const record = await this.persistence.get(this.tenantId);
    if (!active || !record) throw new Error("Tenant configuration not found");
    await this.persistence.save(
      {
        ...record,
        envelope: await encryptEnvelope(
          this.keys,
          this.tenantId,
          "configuration",
          JSON.stringify(active.configuration),
        ),
        updatedAt: new Date(),
      },
      record.version,
    );
  }
}
