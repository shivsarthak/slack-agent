import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openTenantFilesystem } from "../../src/hosted/storage/tenant-filesystem.ts";
import { tenantId } from "../../src/tenant.ts";
import { testTempDir } from "../support/test-root.ts";

describe("Tenant filesystem", () => {
  it("gives each Tenant a separate Vault, Skills, and Session layout", async () => {
    const root = await testTempDir("tenant-filesystem-");
    const filesystem = await openTenantFilesystem(root);
    const alpha = await filesystem.forTenant(tenantId("T_ALPHA"));
    const beta = await filesystem.forTenant(tenantId("T_BETA"));

    expect(alpha.vault).not.toBe(beta.vault);
    expect(alpha.skills).toBe(path.join(alpha.vault, "Skills"));
    await writeFile(path.join(alpha.vault, "Root.md"), "alpha");
    await expect(
      readFile(path.join(beta.vault, "Root.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps Pi Session locators opaque and owned by their Tenant", async () => {
    const root = await testTempDir("tenant-filesystem-");
    const filesystem = await openTenantFilesystem(root);
    const alpha = await filesystem.forTenant(tenantId("T_ALPHA"));
    const beta = await filesystem.forTenant(tenantId("T_BETA"));

    const session = await alpha.createSession();
    expect(session.locator).not.toContain(root);
    expect(session.locator).not.toContain("T_ALPHA");
    await expect(alpha.openSession(session.locator)).resolves.toBe(
      session.directory,
    );
    await expect(beta.openSession(session.locator)).rejects.toThrow(
      /Session locator.*Tenant/,
    );
    await expect(
      alpha.openSession("../../T_BETA" as typeof session.locator),
    ).rejects.toThrow(/Session locator/);
  });

  it("rejects traversal and symlinks that escape a Tenant root", async () => {
    const root = await testTempDir("tenant-filesystem-");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const tenant = await (
      await openTenantFilesystem(root)
    ).forTenant(tenantId("T_ALPHA"));
    await symlink(outside, path.join(tenant.vault, "escape"));

    await expect(tenant.resolveVault("../sessions/secret.txt")).rejects.toThrow(
      /traversal/,
    );
    await expect(tenant.resolveVault("escape/new-secret.txt")).rejects.toThrow(
      /symlink/,
    );
    await expect(
      tenant.resolveExistingVault("escape/secret.txt"),
    ).rejects.toThrow(/symlink/);
  });

  it("rejects a pre-planted symlink in the Tenant layout", async () => {
    const root = await testTempDir("tenant-filesystem-");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const encodedTenant = Buffer.from("T_ALPHA", "utf8").toString("base64url");
    await mkdir(path.join(root, "tenants"));
    await symlink(outside, path.join(root, "tenants", encodedTenant));

    const filesystem = await openTenantFilesystem(root);
    await expect(filesystem.forTenant(tenantId("T_ALPHA"))).rejects.toThrow(
      /symlink/,
    );
  });
});
