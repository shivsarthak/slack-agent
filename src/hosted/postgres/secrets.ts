import type { Pool, QueryResultRow } from "pg";
import type {
  ConfigurationPersistence,
  EncryptedConfigurationRecord,
} from "../../credentials/configuration-vault.ts";
import type { EncryptedEnvelope } from "../../credentials/envelope.ts";
import type {
  CredentialKind,
  CredentialPersistence,
  EncryptedCredentialRecord,
} from "../../credentials/vault.ts";
import { tenantId, type TenantId } from "../../tenant.ts";

function envelope(value: unknown): EncryptedEnvelope {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid encrypted envelope");
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.algorithm !== "A256GCM" ||
    !Number.isInteger(candidate.keyVersion) ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.tag !== "string"
  )
    throw new Error("Invalid encrypted envelope");
  return candidate as unknown as EncryptedEnvelope;
}

function credential(row: QueryResultRow): EncryptedCredentialRecord {
  return {
    tenantId: tenantId(String(row.tenant_id)),
    id: String(row.id),
    kind: String(row.kind) as CredentialKind,
    version: Number(row.version),
    envelope: envelope(row.encrypted_value),
    ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at) } : {}),
    updatedAt: new Date(row.updated_at),
  };
}

export function postgresCredentialPersistence(
  pool: Pool,
): CredentialPersistence {
  return {
    async get(owner: TenantId, id: string) {
      const result = await pool.query(
        "select * from credentials where tenant_id = $1 and id = $2",
        [owner, id],
      );
      return result.rows[0] ? credential(result.rows[0]) : undefined;
    },
    async save(record, expectedVersion) {
      const result = await pool.query(
        `insert into credentials
          (tenant_id, id, kind, encrypted_value, key_version, version, revoked_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, id) do update set
          encrypted_value = excluded.encrypted_value,
          key_version = excluded.key_version,
          version = excluded.version,
          revoked_at = excluded.revoked_at,
          updated_at = excluded.updated_at
         where credentials.kind = excluded.kind
           and credentials.version = $9`,
        [
          record.tenantId,
          record.id,
          record.kind,
          JSON.stringify(record.envelope),
          record.envelope.keyVersion,
          record.version,
          record.revokedAt ?? null,
          record.updatedAt,
          expectedVersion ?? 0,
        ],
      );
      if (result.rowCount !== 1)
        throw new Error(
          `Credential ${record.id} was concurrently changed or has a conflicting kind`,
        );
    },
  };
}

export function postgresConfigurationPersistence(
  pool: Pool,
): ConfigurationPersistence {
  return {
    async get(owner) {
      const result = await pool.query(
        "select * from tenant_configurations where tenant_id = $1",
        [owner],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        tenantId: tenantId(String(row.tenant_id)),
        version: Number(row.version),
        envelope: envelope(row.encrypted_value),
        updatedAt: new Date(row.updated_at),
      } satisfies EncryptedConfigurationRecord;
    },
    async save(record, expectedVersion) {
      const result = await pool.query(
        `insert into tenant_configurations
          (tenant_id, version, encrypted_value, key_version, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id) do update set
          version = excluded.version,
          encrypted_value = excluded.encrypted_value,
          key_version = excluded.key_version,
          updated_at = excluded.updated_at
         where tenant_configurations.version = $6`,
        [
          record.tenantId,
          record.version,
          JSON.stringify(record.envelope),
          record.envelope.keyVersion,
          record.updatedAt,
          expectedVersion ?? 0,
        ],
      );
      if (result.rowCount !== 1)
        throw new Error("Tenant configuration was concurrently changed");
    },
  };
}
