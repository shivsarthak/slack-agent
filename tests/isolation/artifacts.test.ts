import { describe, expect, it } from "vitest";
import {
  openS3ArtifactStore,
  type S3CompatibleClient,
  type UploadHandle,
} from "../../src/hosted/storage/artifacts.ts";
import { tenantId } from "../../src/tenant.ts";

class FakeS3 implements S3CompatibleClient {
  readonly objects = new Map<string, Uint8Array>();

  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
  ): Promise<void> {
    this.objects.set(`${bucket}/${key}`, body.slice());
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    const body = this.objects.get(`${bucket}/${key}`);
    if (!body) throw new Error("Object not found");
    return body.slice();
  }
}

describe("S3-compatible Tenant artifacts", () => {
  it("round-trips uploads and results through scoped handles", async () => {
    const s3 = new FakeS3();
    const artifacts = openS3ArtifactStore({
      client: s3,
      bucket: "artifacts",
      handleSigningKey: Buffer.alloc(32, 7),
    });
    const alpha = tenantId("T_ALPHA");

    const upload = await artifacts.putUpload(alpha, Buffer.from("input"));
    const result = await artifacts.putResult(alpha, Buffer.from("output"));

    expect(upload.tenantId).toBe(alpha);
    expect(upload.kind).toBe("upload");
    expect(result.tenantId).toBe(alpha);
    expect(result.kind).toBe("result");
    await expect(artifacts.readUpload(alpha, upload)).resolves.toEqual(
      Buffer.from("input"),
    );
    await expect(artifacts.readResult(alpha, result)).resolves.toEqual(
      Buffer.from("output"),
    );
    expect([...s3.objects.keys()]).toEqual([
      expect.stringMatching(/^artifacts\/tenants\/[^/]+\/uploads\/[^/]+$/),
      expect.stringMatching(/^artifacts\/tenants\/[^/]+\/results\/[^/]+$/),
    ]);
  });

  it("rejects cross-Tenant, wrong-kind, and forged handles before reading S3", async () => {
    const s3 = new FakeS3();
    const artifacts = openS3ArtifactStore({
      client: s3,
      bucket: "artifacts",
      handleSigningKey: Buffer.alloc(32, 9),
    });
    const alpha = tenantId("T_ALPHA");
    const beta = tenantId("T_BETA");
    const upload = await artifacts.putUpload(alpha, Buffer.from("secret"));

    await expect(artifacts.readUpload(beta, upload)).rejects.toThrow(/Tenant/);
    await expect(artifacts.readResult(alpha, upload as never)).rejects.toThrow(
      /kind/,
    );

    const forged = {
      ...upload,
      objectId: "../../T_BETA/secret",
    } as UploadHandle;
    await expect(artifacts.readUpload(alpha, forged)).rejects.toThrow(/forged/);
  });
});
