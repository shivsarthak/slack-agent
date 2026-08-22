import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TenantId } from "../../tenant.ts";

export interface S3CompatibleClient {
  putObject(bucket: string, key: string, body: Uint8Array): Promise<void>;
  getObject(bucket: string, key: string): Promise<Uint8Array>;
}

interface ArtifactHandle<Kind extends "upload" | "result"> {
  readonly tenantId: TenantId;
  readonly kind: Kind;
  readonly objectId: string;
  readonly signature: string;
}

export type UploadHandle = ArtifactHandle<"upload">;
export type ResultHandle = ArtifactHandle<"result">;

export interface TenantArtifactStore {
  putUpload(tenantId: TenantId, body: Uint8Array): Promise<UploadHandle>;
  readUpload(tenantId: TenantId, handle: UploadHandle): Promise<Uint8Array>;
  putResult(tenantId: TenantId, body: Uint8Array): Promise<ResultHandle>;
  readResult(tenantId: TenantId, handle: ResultHandle): Promise<Uint8Array>;
}

export interface S3ArtifactStoreOptions {
  client: S3CompatibleClient;
  bucket: string;
  /** Deployment secret used only to make serialized handles tamper-evident. */
  handleSigningKey: Uint8Array;
}

/** Build the artifact port over the small common subset of S3-compatible APIs. */
export function openS3ArtifactStore(
  options: S3ArtifactStoreOptions,
): TenantArtifactStore {
  const { client, bucket, handleSigningKey } = options;
  if (bucket.trim().length === 0)
    throw new Error("Artifact bucket must not be empty");
  if (handleSigningKey.byteLength < 32) {
    throw new Error(
      "Artifact handle signing key must contain at least 32 bytes",
    );
  }

  async function put<Kind extends "upload" | "result">(
    tenantId: TenantId,
    kind: Kind,
    body: Uint8Array,
  ): Promise<ArtifactHandle<Kind>> {
    const objectId = randomUUID();
    const handle = Object.freeze({
      tenantId,
      kind,
      objectId,
      signature: sign(handleSigningKey, tenantId, kind, objectId),
    });
    await client.putObject(bucket, objectKey(handle), body);
    return handle;
  }

  async function read<Kind extends "upload" | "result">(
    tenantId: TenantId,
    expectedKind: Kind,
    handle: ArtifactHandle<Kind>,
  ): Promise<Uint8Array> {
    assertHandle(handleSigningKey, tenantId, expectedKind, handle);
    return client.getObject(bucket, objectKey(handle));
  }

  return {
    putUpload: (tenantId, body) => put(tenantId, "upload", body),
    readUpload: (tenantId, handle) => read(tenantId, "upload", handle),
    putResult: (tenantId, body) => put(tenantId, "result", body),
    readResult: (tenantId, handle) => read(tenantId, "result", handle),
  };
}

function assertHandle(
  key: Uint8Array,
  tenantId: TenantId,
  expectedKind: "upload" | "result",
  handle: ArtifactHandle<"upload" | "result">,
): void {
  if (handle.tenantId !== tenantId)
    throw new Error("Artifact handle belongs to another Tenant");
  if (handle.kind !== expectedKind)
    throw new Error("Artifact handle has the wrong kind");
  if (!/^[0-9a-f-]{36}$/i.test(handle.objectId))
    throw new Error("Artifact handle is forged");
  const expected = sign(key, handle.tenantId, handle.kind, handle.objectId);
  const givenBytes = Buffer.from(handle.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (
    givenBytes.length !== expectedBytes.length ||
    !timingSafeEqual(givenBytes, expectedBytes)
  ) {
    throw new Error("Artifact handle is forged");
  }
}

function sign(
  key: Uint8Array,
  tenantId: TenantId,
  kind: "upload" | "result",
  objectId: string,
): string {
  return createHmac("sha256", key)
    .update(`${tenantId}\0${kind}\0${objectId}`)
    .digest("base64url");
}

function objectKey(handle: ArtifactHandle<"upload" | "result">): string {
  const tenant = Buffer.from(handle.tenantId, "utf8").toString("base64url");
  return `tenants/${tenant}/${handle.kind}s/${handle.objectId}`;
}
