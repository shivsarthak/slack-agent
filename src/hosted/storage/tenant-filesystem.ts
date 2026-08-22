import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { TenantId } from "../../tenant.ts";

export type PiSessionLocator = string & {
  readonly __piSessionLocator: unique symbol;
};

export interface TenantFilesystemLayout {
  readonly vault: string;
  readonly skills: string;
  readonly sessions: string;
  resolveVault(relativePath: string): Promise<string>;
  resolveExistingVault(relativePath: string): Promise<string>;
  createSession(): Promise<{ locator: PiSessionLocator; directory: string }>;
  openSession(locator: PiSessionLocator): Promise<string>;
}

export interface TenantFilesystem {
  forTenant(tenantId: TenantId): Promise<TenantFilesystemLayout>;
}

/**
 * Open the encrypted attached-storage mount used by hosted workers.
 *
 * Encryption is a property of the supplied volume. This adapter owns the on-volume
 * Tenant layout and deliberately exposes no path that is above one Tenant's root.
 */
export async function openTenantFilesystem(
  encryptedStorageRoot: string,
): Promise<TenantFilesystem> {
  await mkdir(encryptedStorageRoot, { recursive: true });
  const storageRoot = await realpath(encryptedStorageRoot);
  const tenantsRoot = path.join(storageRoot, "tenants");
  await mkdir(tenantsRoot, { recursive: true });
  await assertDirectoryIsNotSymlink(tenantsRoot);

  return {
    async forTenant(tenantId: TenantId): Promise<TenantFilesystemLayout> {
      const tenantRoot = path.join(tenantsRoot, encodeTenantId(tenantId));
      const vault = path.join(tenantRoot, "vault");
      const skills = path.join(vault, "Skills");
      const sessions = path.join(tenantRoot, "sessions");
      await mkdir(tenantRoot, { recursive: true });
      await assertDirectoryIsNotSymlink(tenantRoot);
      await mkdir(vault, { recursive: true });
      await assertDirectoryIsNotSymlink(vault);
      await Promise.all([
        mkdir(path.join(vault, "Notes"), { recursive: true }),
        mkdir(skills, { recursive: true }),
        mkdir(sessions, { recursive: true }),
      ]);
      await Promise.all([
        assertDirectoryIsNotSymlink(skills),
        assertDirectoryIsNotSymlink(sessions),
      ]);

      return {
        vault,
        skills,
        sessions,
        async resolveVault(relativePath: string): Promise<string> {
          const candidate = resolveBelow(vault, relativePath);
          await rejectSymlinks(vault, candidate, false);
          return candidate;
        },
        async resolveExistingVault(relativePath: string): Promise<string> {
          const candidate = resolveBelow(vault, relativePath);
          await rejectSymlinks(vault, candidate, true);
          return candidate;
        },
        async createSession() {
          await assertDirectoryIsNotSymlink(sessions);
          const locator = randomUUID() as PiSessionLocator;
          const directory = path.join(sessions, locator);
          await mkdir(directory);
          return { locator, directory };
        },
        async openSession(locator: PiSessionLocator): Promise<string> {
          if (!isLocator(locator))
            throw new Error("Session locator is invalid");
          const directory = path.join(sessions, locator);
          try {
            await rejectSymlinks(sessions, directory, true);
            const metadata = await lstat(directory);
            if (!metadata.isDirectory() || metadata.isSymbolicLink())
              throw new Error();
          } catch {
            throw new Error("Session locator does not belong to this Tenant");
          }
          return directory;
        },
      };
    },
  };
}

function encodeTenantId(tenantId: TenantId): string {
  return Buffer.from(tenantId, "utf8").toString("base64url");
}

function resolveBelow(root: string, relativePath: string): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error("Tenant path traversal is not allowed");
  }
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Tenant path traversal is not allowed");
  }
  return candidate;
}

async function rejectSymlinks(
  root: string,
  candidate: string,
  targetMustExist: boolean,
): Promise<void> {
  await assertDirectoryIsNotSymlink(root);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (
        !targetMustExist &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new Error("Tenant path symlink escape is not allowed");
  }
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error("Tenant path symlink escape is not allowed");
  }
}

async function assertDirectoryIsNotSymlink(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Tenant path symlink escape is not allowed");
  }
}

function isLocator(locator: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    locator,
  );
}
